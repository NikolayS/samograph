/**
 * Capability-token STORE tests — the DB-backed half of §6.2 #2.
 *
 * Run against the CI ephemeral Postgres (real migrations + real `tokens`
 * table; SPEC §6.1), skipped when DATABASE_URL is unset so the mock-free DB
 * suite only runs on the Postgres-backed job. We connect as the superuser
 * (which bypasses RLS) and seed a tenant/call exactly like the RLS suite; the
 * production caller (the tenancy gate, #41) supplies tenant context.
 *
 * Strict red/green TDD: written BEFORE ./store.ts exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mintShareToken, mintToken, verifyToken, revokeToken } from "./store.ts";
import { signToken, type Keyring, type SigningKey } from "./signing.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const KEY_CURRENT: SigningKey = { kid: "k2", secret: "store-current-secret-xxxxxxxxxxxxxxxxxxxxxxxx" };
const KEY_PREVIOUS: SigningKey = { kid: "k1", secret: "store-previous-secret-yyyyyyyyyyyyyyyyyyyyyyyy" };
const keyring: Keyring = { current: KEY_CURRENT, previous: KEY_PREVIOUS };

d("capability token store (§5.7, §6.2 #2 — persisted scopes)", () => {
  let sql: ReturnType<typeof connect>;
  const userId = randomUUID();
  const tenantId = randomUUID();
  const callId = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@t.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status)
              VALUES (${callId}, ${tenantId}, 'https://meet.google.com/tok', 'IN_CALL')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM tokens WHERE call_id = ${callId}`;
    await sql`DELETE FROM calls WHERE id = ${callId}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.close();
  });

  async function countTokens(): Promise<number> {
    const r = await sql`SELECT count(*)::int AS c FROM tokens WHERE call_id = ${callId}`;
    return r[0].c;
  }

  it("mintShareToken writes exactly one tokens row with scopes=['share'], kid, jti, no revoke", async () => {
    const before = await countTokens();
    const minted = await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    expect(await countTokens()).toBe(before + 1);

    const rows = await sql`SELECT scopes, kid, jti, revoked_at FROM tokens WHERE jti = ${minted.jti}`;
    expect(rows.length).toBe(1);
    expect(rows[0].scopes).toEqual(["share"]);
    expect(rows[0].kid).toBe("k2");
    expect(rows[0].jti).toBe(minted.jti);
    expect(rows[0].revoked_at).toBeNull();
  });

  it("round-trips a freshly minted share token through the FULL DB-backed verifier", async () => {
    const minted = await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const res = await verifyToken(sql, minted.token, keyring, { requireScope: "share" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.callId).toBe(callId);
    expect(res.scopes).toEqual(["share"]);
  });

  it("denies a scope the token does not hold (asks act:chat, token holds only share)", async () => {
    const minted = await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const res = await verifyToken(sql, minted.token, keyring, { requireScope: "act:chat" });
    expect(res).toEqual({ ok: false, reason: "scope_denied" });
  });

  it("rejects a revoked token (revoke = set revoked_at; revoked → invalid)", async () => {
    const minted = await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    expect((await verifyToken(sql, minted.token, keyring, { requireScope: "share" })).ok).toBe(true);

    const revoked = await revokeToken(sql, minted.jti);
    expect(revoked).toBe(true);

    const res = await verifyToken(sql, minted.token, keyring, { requireScope: "share" });
    expect(res).toEqual({ ok: false, reason: "revoked" });
  });

  it("revokeToken returns false for an unknown / already-revoked jti (idempotent)", async () => {
    expect(await revokeToken(sql, randomUUID())).toBe(false);
    const minted = await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    expect(await revokeToken(sql, minted.jti)).toBe(true);
    expect(await revokeToken(sql, minted.jti)).toBe(false); // second revoke is a no-op
  });

  it("rejects an expired persisted token (verified after exp)", async () => {
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    const minted = await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 60, now: t0 });
    const res = await verifyToken(sql, minted.token, keyring, { now: t0 + 3600 });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("enforces jti uniqueness — replaying a jti across mints is rejected (SQLSTATE 23505)", async () => {
    const jti = randomUUID();
    await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600, jti });

    let caught: { errno?: string } | null = null;
    try {
      await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600, jti });
    } catch (e) {
      caught = e as { errno?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.errno).toBe("23505");
  });

  it("rejects a correctly-signed token whose jti was never persisted (forgery / cross-rotation replay)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      { kid: "k2", call_id: callId, scopes: ["share"], iat: now, exp: now + 3600, jti: randomUUID() },
      KEY_CURRENT,
    );
    const res = await verifyToken(sql, token, keyring, { requireScope: "share" });
    expect(res).toEqual({ ok: false, reason: "not_persisted" });
  });

  it("verifies a persisted token signed under the PREVIOUS KID (rotation overlap)", async () => {
    const minted = await mintShareToken(sql, { callId, signingKey: KEY_PREVIOUS, ttlSeconds: 3600 });
    const res = await verifyToken(sql, minted.token, keyring, { requireScope: "share" });
    expect(res.ok).toBe(true);
  });

  it("rejects a persisted token whose signing KID is not in the keyring (retired KID)", async () => {
    const retired: SigningKey = { kid: "k0", secret: "store-retired-secret-zzzzzzzzzzzzzzzzzzzzzzzz" };
    const minted = await mintShareToken(sql, { callId, signingKey: retired, ttlSeconds: 3600 });
    const res = await verifyToken(sql, minted.token, keyring, { requireScope: "share" });
    expect(res).toEqual({ ok: false, reason: "unknown_kid" });
  });

  // §6.2 #2 ROW-COUNT assertion: `read` is derived, never persisted — minting it
  // must be refused and must create ZERO `tokens` rows. (Session-derivation of
  // `read` + sign-out invalidation are the tenancy gate's job, #41.)
  it("ROW-COUNT: minting a `read` capability is refused and creates ZERO tokens rows", async () => {
    const before = await countTokens();
    let threw = false;
    try {
      await mintToken(sql, { callId, scopes: ["read"], signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    } catch {
      threw = true;
    }
    const after = await countTokens();
    console.log(
      `[row-count] read derivation refused=${threw}; tokens rows before=${before} after=${after} (delta=${after - before})`,
    );
    expect(threw).toBe(true);
    expect(after).toBe(before); // ZERO new rows for the derived read scope
  });
});
