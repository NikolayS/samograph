/**
 * `GET /settings` → the read-only Sign-in block's data (SPEC amendment S5-1
 * item 8, §5.12; issue #223) — DB-backed integration against the CI ephemeral
 * Postgres with the REAL migrations + REAL RLS (SPEC §6.1). Skips cleanly when
 * DATABASE_URL is unset.
 *
 * WHY THIS TEST EXISTS AT THE DB LAYER AND NOT AGAINST A FAKE: `user_identities`
 * (migration 0011) carries NO Row-Level Security and is deliberately NOT granted
 * to `samograph_app`, so the tenancy gate that protects every other `/settings`
 * read protects nothing here. Cross-user isolation is a property of the WHERE
 * clause alone, and the only honest place to assert it is against real Postgres.
 *
 * Covers:
 *  (1) a magic-link-only user → `signin.identities` is exactly `[]`;
 *  (2) a Google-linked user → exactly one `provider === "google"` entry, and the
 *      serialized payload contains NO `provider_subject` and NO provider-asserted
 *      `user_identities.email`;
 *  (3) cross-user isolation — user B's identity never appears in user A's read;
 *  (4) no cookie → 401, and a validly-signed cookie for a dead tenant (#114) → 401.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import { createSettingsHandler } from "./http.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "settings-signin-db-test-secret-dddddddddddddddddddd";

/** The seeded Google `sub`. It must NEVER appear in any response body. */
const GOOGLE_SUB_A = "sub-223-user-a-108176061234567890123";
const GOOGLE_SUB_B = "sub-223-user-b-999999999999999999999";
/** The provider-ASSERTED address — deliberately not authoritative, never served. */
const GOOGLE_ASSERTED_EMAIL_A = "provider-asserted-223-a@gmail.test";

interface SignInWire {
  email: string;
  identities: Array<{ provider: string; connected_at: string }>;
}

d("GET /settings — Sign-in block data (S5-1 item 8, #223)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const emailA = `signin-a-${userA}@a.test`;
  const emailB = `signin-b-${userB}@b.test`;

  const iat = Date.now();
  const cookieA = signSession({ userId: userA, tenantId: tenantA, iat }, SESSION_SECRET);
  const cookieB = signSession({ userId: userB, tenantId: tenantB, iat }, SESSION_SECRET);

  function req(path: string, cookie?: string) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
    return new Request(`http://app-api.local${path}`, { method: "GET", headers });
  }

  function handler() {
    return createSettingsHandler({ sql, sessionSecret: SESSION_SECRET });
  }

  /** GET /settings as `cookie`, returning the raw text AND the parsed signin block. */
  async function getSignIn(cookie: string): Promise<{ raw: string; signin: SignInWire }> {
    const res = await handler()(req("/settings", cookie));
    expect(res.status).toBe(200);
    const raw = await res.text();
    return { raw, signin: (JSON.parse(raw) as { signin: SignInWire }).signin };
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${emailA}), (${userB}, ${emailB})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  // ── (1) magic-link-only user ────────────────────────────────────────────────
  it("a user with no external identity → signin.identities is exactly []", async () => {
    const { signin } = await getSignIn(cookieA);
    expect(signin.identities).toEqual([]);
    // The authoritative, immutable `users.email` — the address magic links go to.
    expect(signin.email).toBe(emailA);
  });

  // ── (3) cross-user isolation (asserted BEFORE A is linked, and again after) ──
  it("user B's Google identity never appears in user A's read (no RLS on 0011)", async () => {
    await sql`INSERT INTO user_identities (user_id, provider, provider_subject, email)
              VALUES (${userB}, 'google', ${GOOGLE_SUB_B}, ${"b-asserted@gmail.test"})`;
    const { raw, signin } = await getSignIn(cookieA);
    expect(signin.identities).toEqual([]);
    expect(raw).not.toContain(GOOGLE_SUB_B);
    // …and B genuinely has the identity, so the empty A read is isolation, not a bug.
    const b = await getSignIn(cookieB);
    expect(b.signin.identities.map((i) => i.provider)).toEqual(["google"]);
  });

  // ── (2) Google-linked user ──────────────────────────────────────────────────
  it("a Google-linked user → exactly one google entry, with no sub and no asserted email", async () => {
    await sql`INSERT INTO user_identities (user_id, provider, provider_subject, email)
              VALUES (${userA}, 'google', ${GOOGLE_SUB_A}, ${GOOGLE_ASSERTED_EMAIL_A})`;
    const { raw, signin } = await getSignIn(cookieA);

    expect(signin.identities.length).toBe(1);
    expect(signin.identities[0]!.provider).toBe("google");
    expect(typeof signin.identities[0]!.connected_at).toBe("string");
    // The identity KEY is personal data and is never served — string-containment,
    // so this fails the moment the field is added back under any name.
    expect(raw).not.toContain(GOOGLE_SUB_A);
    expect(raw).not.toContain("provider_subject");
    // The provider-asserted address is not authoritative (S5-1 items 2-3): only
    // `users.email` is served.
    expect(raw).not.toContain(GOOGLE_ASSERTED_EMAIL_A);
    expect(signin.email).toBe(emailA);
    // Exact serialized key set — nothing beyond presence + connection metadata.
    expect(Object.keys(signin.identities[0]!).sort()).toEqual(["connected_at", "provider"]);
  });

  // ── (4) auth posture ────────────────────────────────────────────────────────
  it("no cookie → 401 (no signin block leaks to an anonymous caller)", async () => {
    const res = await handler()(req("/settings"));
    expect(res.status).toBe(401);
  });

  it("a validly-signed cookie whose tenant no longer exists → 401 (#114)", async () => {
    const dead = signSession(
      { userId: userA, tenantId: randomUUID(), iat: Date.now() },
      SESSION_SECRET,
    );
    const res = await handler()(req("/settings", dead));
    expect(res.status).toBe(401);
  });
});
