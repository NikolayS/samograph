/**
 * Share-link mint/revoke endpoints — DB-backed integration (SPEC §5.7, §5.10,
 * §6.2 #2/#10, §8 Sprint-2 Backend). Mirrors §6.2 #2 (mint round-trip; read never
 * persisted) + §6.2 #10 (owner mint/revoke + audit, adversarial denials).
 *
 * Runs against the CI ephemeral Postgres with the REAL migrations + REAL RLS (no
 * mocks; §6.1) and skips cleanly when DATABASE_URL is unset. Builds ON the merged
 * Sprint-1 token store (`mintShareToken`/`revokeToken`/`verifyToken`), the
 * `tokens` + `audit_log` tables, and the tenancy gate — none are reimplemented.
 *
 * Strict red/green TDD: written BEFORE the `/calls/:id/share` routes exist.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { verifyToken } from "../../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../../packages/shared/tokens/signing.ts";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import { createCallsHandler } from "./http.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "share-db-test-session-secret-cccccccccccccccccccc";
const KEY_CURRENT: SigningKey = { kid: "k9", secret: "share-current-secret-dddddddddddddddddddddddd" };
const keyring: Keyring = { current: KEY_CURRENT };

/** sha256-hex, the exact transform the audit writes over the token id (never the secret). */
function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

d("/calls/:id/share mint+revoke (DB-backed, §5.7 / §6.2 #10)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID(); // tenant A
  const callB = randomUUID(); // tenant B

  const cookieA = signSession({ userId: userA, tenantId: tenantA, iat: 1 }, SESSION_SECRET);
  const cookieB = signSession({ userId: userB, tenantId: tenantB, iat: 1 }, SESSION_SECRET);

  const handler = () =>
    createCallsHandler({ sql, sessionSecret: SESSION_SECRET, enqueue: () => {}, keyring });

  function req(
    method: string,
    path: string,
    opts: { cookie?: string } = {},
  ): Request {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
    return new Request(`http://app-api.local${path}`, { method, headers });
  }

  async function countTokens(callId: string): Promise<number> {
    const r = await sql`SELECT count(*)::int AS c FROM tokens WHERE call_id = ${callId}`;
    return (r[0] as { c: number }).c;
  }
  async function countAudit(callId: string, action: string): Promise<number> {
    const r = await sql`SELECT count(*)::int AS c FROM audit_log WHERE call_id = ${callId} AND action = ${action}`;
    return (r[0] as { c: number }).c;
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/share-a', 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://meet.google.com/share-b', 'IN_CALL')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`; // CASCADE clears the rest
    await sql.close();
  });

  // ── AC#1: owner mints → one `share` tokens row + one `share.mint` audit row ──
  it("owner POST /calls/:id/share → 201, ONE share token row, verifiable link, ONE share.mint audit row", async () => {
    const before = await countTokens(callA);
    const nowSec = Math.floor(Date.now() / 1000);

    const res = await handler()(req("POST", `/calls/${callA}/share`, { cookie: cookieA }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; token_id: string; url: string };
    expect(typeof body.token).toBe("string");
    expect(typeof body.token_id).toBe("string");
    expect(body.url).toBe(`/c/${body.token}`); // the `/c/<token>` read-only link

    // Exactly ONE new tokens row for this call, with the right shape (exact values).
    expect(await countTokens(callA)).toBe(before + 1);
    const rows = await sql`SELECT scopes, kid, jti, expires_at, revoked_at FROM tokens WHERE jti = ${body.token_id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].scopes).toEqual(["share"]); // ONLY share — no `read` row is ever created
    expect(rows[0].kid).toBe(KEY_CURRENT.kid);
    expect(rows[0].jti).toBe(body.token_id);
    expect(rows[0].revoked_at).toBeNull();
    expect(new Date(rows[0].expires_at as string).getTime() / 1000).toBeGreaterThan(nowSec);

    // The returned link verifies through the FULL DB-backed verifier for THIS call.
    const v = await verifyToken(sql, body.token, keyring, { requireScope: "share" });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(v.reason);
    expect(v.callId).toBe(callA);
    expect(v.scopes).toEqual(["share"]);

    // Exactly ONE audit row: actor=user:<id>, action=share.mint, payload_sha256 of the
    // token id (NEVER the secret).
    const audit = await sql`SELECT actor, action, tenant_id, payload_sha256 FROM audit_log WHERE call_id = ${callA} AND action = 'share.mint'`;
    expect(audit.length).toBe(1);
    expect(audit[0].actor).toBe(`user:${userA}`);
    expect(audit[0].tenant_id).toBe(tenantA);
    expect(audit[0].payload_sha256).toBe(sha256hex(body.token_id));
    expect(audit[0].payload_sha256).not.toBe(body.token); // never the secret
  });

  // ── AC#2: revoke stamps revoked_at, audits once, idempotent ─────────────────
  it("owner DELETE /calls/:id/share/:tokenId → 204, stamps revoked_at, ONE share.revoke audit, idempotent", async () => {
    const mint = await handler()(req("POST", `/calls/${callA}/share`, { cookie: cookieA }));
    const { token, token_id } = (await mint.json()) as { token: string; token_id: string };
    expect((await verifyToken(sql, token, keyring, { requireScope: "share" })).ok).toBe(true);

    const del = await handler()(req("DELETE", `/calls/${callA}/share/${token_id}`, { cookie: cookieA }));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");

    const rows = await sql`SELECT revoked_at FROM tokens WHERE jti = ${token_id}`;
    expect(rows[0].revoked_at).not.toBeNull(); // stamped
    expect(await countAudit(callA, "share.revoke")).toBe(1);
    // The link no longer verifies (revoke round-trip proven via the merged verifier).
    expect((await verifyToken(sql, token, keyring, { requireScope: "share" })).ok).toBe(false);

    // Second revoke of the same jti is a no-op: still 204, NO second audit row.
    const del2 = await handler()(req("DELETE", `/calls/${callA}/share/${token_id}`, { cookie: cookieA }));
    expect(del2.status).toBe(204);
    expect(await countAudit(callA, "share.revoke")).toBe(1);
  });

  // ── AC#3: adversarial — owner-only, cross-tenant denied, share-cred can't mint ─
  it("mint: missing session → 401 bodyless, NO token row created", async () => {
    const before = await countTokens(callA);
    const res = await handler()(req("POST", `/calls/${callA}/share`));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(await countTokens(callA)).toBe(before);
  });

  it("mint: cross-tenant call_id (tenant B minting on tenant A's call) → 403, NO token row", async () => {
    const before = await countTokens(callA);
    const res = await handler()(req("POST", `/calls/${callA}/share`, { cookie: cookieB }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(await countTokens(callA)).toBe(before);
  });

  it("mint: a SHARE-scope credential (token, no session) cannot mint → 403, NO token row", async () => {
    // First mint a real share token as the owner, then try to use IT to mint another.
    const mint = await handler()(req("POST", `/calls/${callA}/share`, { cookie: cookieA }));
    const { token } = (await mint.json()) as { token: string };
    const before = await countTokens(callA);
    const res = await handler()(req("POST", `/calls/${callA}/share?token=${encodeURIComponent(token)}`));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(await countTokens(callA)).toBe(before); // share credential minted nothing
  });

  it("revoke: cross-tenant (tenant B revoking tenant A's token) → 403, token stays active", async () => {
    const mint = await handler()(req("POST", `/calls/${callA}/share`, { cookie: cookieA }));
    const { token_id } = (await mint.json()) as { token_id: string };

    const res = await handler()(req("DELETE", `/calls/${callA}/share/${token_id}`, { cookie: cookieB }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    const rows = await sql`SELECT revoked_at FROM tokens WHERE jti = ${token_id}`;
    expect(rows[0].revoked_at).toBeNull(); // never revoked by the cross-tenant attempt
  });

  it("revoke: missing session → 401; a SHARE-scope credential cannot revoke → 403", async () => {
    const mint = await handler()(req("POST", `/calls/${callA}/share`, { cookie: cookieA }));
    const { token, token_id } = (await mint.json()) as { token: string; token_id: string };

    const noSession = await handler()(req("DELETE", `/calls/${callA}/share/${token_id}`));
    expect(noSession.status).toBe(401);

    const shareCred = await handler()(
      req("DELETE", `/calls/${callA}/share/${token_id}?token=${encodeURIComponent(token)}`),
    );
    expect(shareCred.status).toBe(403);

    const rows = await sql`SELECT revoked_at FROM tokens WHERE jti = ${token_id}`;
    expect(rows[0].revoked_at).toBeNull(); // neither attempt revoked it
  });
});
