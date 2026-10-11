/**
 * Google sign-in AFTER a §5.14 account erasure — the resurrection fence (#220).
 *
 * §5.14 erasure is a TOMBSTONE erasure: `apps/app-api/account/http.ts` purges the
 * tenant's rows and writes one `audit_log(action='account_deleted')`, but keeps
 * the `users` and `tenants` rows so `tenantActive` can revoke every stateless
 * session cookie. #218 correctly added an explicit `DELETE FROM user_identities`
 * (S5-1 item 9) — but nothing stopped the NEXT Google sign-in from putting the
 * provider `sub` straight back: `findByProviderSubject` missed, `findByEmail` HIT
 * the retained `users`/`tenants` rows, and the callback linked a fresh identity
 * to the erased account AND emailed the erased address about it.
 *
 * The fix chosen here (see the PR / `SPEC.amendments.md` S5-2) is to RELEASE the
 * owner's address at erasure time — the retained `users` row is anonymized to
 * `deleted-<user id>@deleted.invalid` — so:
 *
 *  - `findByEmail` can no longer HIT the erased account at all: the tombstone
 *    holds no address to match, so no identity row and no notification email can
 *    ever attach to it (criteria 1 and 2), on ANY sign-in path;
 *  - the person who erased their account is not permanently locked out by their
 *    own tombstone — signing in again provisions a GENUINELY FRESH user + tenant
 *    with no history, instead of a "welcome back" redirect into a dead session
 *    (criterion 3, satisfied by a truthful WORKING outcome rather than an error);
 *  - the erased tenant's own cookie still 401s `SAMO-AUTH-005` (criterion 4).
 *
 * DB-backed on purpose: the tombstone lives in `audit_log` and the address
 * uniqueness lives in the `users` UNIQUE index, so an in-memory fake cannot prove
 * any of this. Skips cleanly when DATABASE_URL is unset, like every `.db.test`.
 *
 * The OAuth leg uses `InMemoryOAuthProvider` (state/nonce/PKCE still enforced) —
 * the real RS256/JWKS crypto is already covered end to end by
 * `google-routes.test.ts`; what is under test HERE is the store/erasure seam.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect, migrate } from "../../../packages/shared/db/index.ts";
import { InMemoryOAuthProvider } from "./oauth.ts";
import { PostgresUserStore } from "./pg-user-store.ts";
import { PostgresIdentityStore } from "./pg-identity-store.ts";
import { InMemoryEmailSender } from "./email.ts";
import { InMemoryRateLimiter } from "./rate-limit.ts";
import { GoogleAuthService } from "./google-service.ts";
import { createGoogleAuthHandler } from "./google-http.ts";
import { createAccountHandler, erasedAccountEmail } from "../account/http.ts";
import { OAUTH_STATE_COOKIE_NAME } from "./oauth-state.ts";
import { SESSION_COOKIE_NAME, verifySession } from "./session.ts";
import { tenantActive } from "./owner-session.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "erased-account-google-signin-secret-cccccccccccccccc";

d("Google sign-in after a §5.14 erasure — no resurrection (#220)", () => {
  let sql: ReturnType<typeof connect>;
  const createdUsers: string[] = [];

  /** One fully-composed stack: Google routes + `DELETE /account`, one Postgres. */
  function stack() {
    const provider = new InMemoryOAuthProvider();
    const emailSender = new InMemoryEmailSender();
    const service = new GoogleAuthService({
      provider,
      identityStore: new PostgresIdentityStore(sql),
      userStore: new PostgresUserStore(sql),
      emailSender,
      rateLimiter: new InMemoryRateLimiter(),
      sessionSecret: SESSION_SECRET,
      clock: () => Date.now(),
      logger: { error: () => {} },
    });
    return {
      provider,
      emailSender,
      google: createGoogleAuthHandler(service),
      account: createAccountHandler({ sql, sessionSecret: SESSION_SECRET, emailSender }),
    };
  }

  type Stack = ReturnType<typeof stack>;

  /** The raw signed value of a named cookie a response set, or undefined. */
  function cookieValue(res: Response, name: string): string | undefined {
    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    if (header === undefined) return undefined;
    const value = header.slice(`${name}=`.length).split(";")[0];
    return value.length === 0 ? undefined : value;
  }

  /** start → "Google" → callback, with a real signed state cookie throughout. */
  async function signInWithGoogle(
    s: Stack,
    identity: { subject: string; email: string },
  ): Promise<Response> {
    const startRes = await s.google(new Request("http://api.test/auth/google/start"));
    const authorizeUrl = startRes.headers.get("location") ?? "";
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    const code = s.provider.issueCode(state, {
      provider: "google",
      subject: identity.subject,
      email: identity.email,
      emailVerified: true,
    });
    return s.google(
      new Request(
        `http://api.test/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: `${OAUTH_STATE_COOKIE_NAME}=${cookieValue(startRes, OAUTH_STATE_COOKIE_NAME)}`,
          },
        },
      ),
    );
  }

  /** The session claims a callback response minted, or undefined when it minted none. */
  function sessionClaims(res: Response): { userId: string; tenantId: string } | undefined {
    const raw = cookieValue(res, SESSION_COOKIE_NAME);
    if (raw === undefined) return undefined;
    const claims = verifySession(raw, SESSION_SECRET, Date.now());
    return claims === null ? undefined : { userId: claims.userId, tenantId: claims.tenantId };
  }

  async function countIdentitiesFor(userId: string): Promise<number> {
    const rows = (await sql`
      SELECT count(*)::int AS c FROM user_identities WHERE user_id = ${userId}`) as unknown as Array<{
      c: number;
    }>;
    return rows[0].c;
  }

  async function emailOf(userId: string): Promise<string | undefined> {
    const rows = (await sql`SELECT email FROM users WHERE id = ${userId}`) as unknown as Array<{
      email: string;
    }>;
    return rows.length === 0 ? undefined : rows[0].email;
  }

  /**
   * Sign in with Google, then erase the account through the REAL `DELETE /account`
   * handler. Returns the erased owner's ids plus the address and `sub` used, so
   * the second sign-in can replay EXACTLY the same credential.
   */
  async function signInThenErase(label: string): Promise<{
    s: Stack;
    email: string;
    subject: string;
    erasedUserId: string;
    erasedTenantId: string;
    erasedCookie: string;
  }> {
    const s = stack();
    const email = `erased-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const subject = `sub-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const first = await signInWithGoogle(s, { subject, email });
    const claims = sessionClaims(first);
    if (claims === undefined) throw new Error("first Google sign-in minted no session");
    createdUsers.push(claims.userId);

    const erasedCookie = cookieValue(first, SESSION_COOKIE_NAME)!;
    const deleted = await s.account(
      new Request("http://api.test/account", {
        method: "DELETE",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${erasedCookie}` },
      }),
    );
    expect(deleted.status).toBe(200);

    return {
      s,
      email,
      subject,
      erasedUserId: claims.userId,
      erasedTenantId: claims.tenantId,
      erasedCookie,
    };
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    // tenants / user_identities / calls all cascade from users.
    for (const id of createdUsers) await sql`DELETE FROM users WHERE id = ${id}`;
    await sql.close();
  });

  // ── Criterion 1 ──────────────────────────────────────────────────────────
  it("writes NO user_identities row for the erased owner on a second Google callback", async () => {
    const ctx = await signInThenErase("no-identity");

    // The erasure itself (S5-1 item 9) — exactly zero, not "fewer".
    expect(await countIdentitiesFor(ctx.erasedUserId)).toBe(0);

    const second = await signInWithGoogle(ctx.s, {
      subject: ctx.subject,
      email: ctx.email,
    });
    const fresh = sessionClaims(second);
    if (fresh !== undefined) createdUsers.push(fresh.userId);

    // …and still exactly zero after the SAME (sub, email) signs in again.
    expect(await countIdentitiesFor(ctx.erasedUserId)).toBe(0);
  });

  // ── Criterion 2 ──────────────────────────────────────────────────────────
  it("sends NO identity-linked email when the erased address signs in again", async () => {
    const ctx = await signInThenErase("no-email");
    expect(ctx.s.emailSender.sentIdentityLinks).toEqual([]);

    const second = await signInWithGoogle(ctx.s, {
      subject: ctx.subject,
      email: ctx.email,
    });
    const fresh = sessionClaims(second);
    if (fresh !== undefined) createdUsers.push(fresh.userId);

    // Exactly `[]` — the erased address is never told anything was attached to it.
    expect(ctx.s.emailSender.sentIdentityLinks).toEqual([]);
  });

  // ── Criterion 3 ──────────────────────────────────────────────────────────
  it("provisions a genuinely FRESH account instead of adopting the tombstone", async () => {
    const ctx = await signInThenErase("fresh-account");

    // The tombstone no longer carries the person's address (that is WHY the link
    // branch can never fire for it) — the exact anonymized form is pinned.
    expect(await emailOf(ctx.erasedUserId)).toBe(erasedAccountEmail(ctx.erasedUserId));

    const second = await signInWithGoogle(ctx.s, {
      subject: ctx.subject,
      email: ctx.email,
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe("/dashboard");

    const fresh = sessionClaims(second);
    expect(fresh).toBeDefined();
    createdUsers.push(fresh!.userId);

    // A NEW user and a NEW tenant — never the erased ones.
    expect(fresh!.userId).not.toBe(ctx.erasedUserId);
    expect(fresh!.tenantId).not.toBe(ctx.erasedTenantId);
    // …and the new tenant is ACTIVE, so this session actually works.
    expect(await tenantActive(sql, fresh!.tenantId)).toBe(true);
    expect(await tenantActive(sql, ctx.erasedTenantId)).toBe(false);

    // The re-linked `sub` belongs to the FRESH user, and the erased owner owns none.
    const owner = (await sql`
      SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_subject = ${ctx.subject}`) as unknown as Array<{
      user_id: string;
    }>;
    expect(owner.map((r) => r.user_id)).toEqual([fresh!.userId]);
    expect(await countIdentitiesFor(ctx.erasedUserId)).toBe(0);
  });

  // ── Criterion 4 ──────────────────────────────────────────────────────────
  it("still 401s SAMO-AUTH-005 on the ERASED tenant's own cookie", async () => {
    const ctx = await signInThenErase("dead-cookie");
    const res = await ctx.s.account(
      new Request("http://api.test/account", {
        method: "DELETE",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${ctx.erasedCookie}` },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "SAMO-AUTH-005",
      message: "You've been signed out. Please sign in again.",
      retryable: false,
    });
  });

  // ── The magic-link path inherits the same fence, for free ────────────────
  it("lets the magic-link path provision a fresh account on the released address", async () => {
    const ctx = await signInThenErase("magic-link");

    const store = new PostgresUserStore(sql);
    const reborn = await store.createOrLoadUser(ctx.email);
    createdUsers.push(reborn.id);

    expect(reborn.email).toBe(ctx.email.toLowerCase());
    expect(reborn.id).not.toBe(ctx.erasedUserId);
    expect(reborn.tenantId).not.toBe(ctx.erasedTenantId);
    expect(await tenantActive(sql, reborn.tenantId)).toBe(true);

    // `findByEmail` — the Google callback's link-to-existing probe — now resolves
    // the FRESH account, and can never resolve the erased one again.
    const found = await store.findByEmail(ctx.email);
    expect(found).toEqual(reborn);
  });
});
