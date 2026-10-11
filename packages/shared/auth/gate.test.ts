/**
 * Tenant-isolation authorization-gate tests — §6.2 #4 (adversarial + fuzz +
 * revoke-without-cache), the security hinge of §5.6.
 *
 * Strict red/green TDD: this suite is written FIRST and asserts EXACT values.
 * Every adversarial case must end in the single bodyless 403 (`DENY`); the happy
 * paths assert the exact grant, including the row-count proof that the
 * session-derived `read` scope writes NO `tokens` row (§5.7, §6.2 #2).
 *
 * Two surfaces:
 *   1. Credential-resolution invariants (no DB) — always run: with no resolvable
 *      credential the gate denies and NEVER touches tenant context, and a fuzz
 *      round never authorizes.
 *   2. DB-backed tenant isolation — run against the CI ephemeral Postgres (real
 *      migrations, real RLS, real `tokens` table; SPEC §6.1), skipped cleanly
 *      when DATABASE_URL is unset. Reuses the #50 client + #52 verifier; the gate
 *      is exercised as the NON-super `samograph_app` role so RLS truly applies.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mintShareToken, mintToken, revokeToken } from "../tokens/store.ts";
import { signToken, type Keyring, type SigningKey } from "../tokens/signing.ts";
import {
  authorizeCall,
  type AuthorizeDeps,
  type AuthorizeRequest,
  type Session,
} from "./gate.ts";

const KEY_CURRENT: SigningKey = { kid: "k2", secret: "auth-current-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const KEY_PREVIOUS: SigningKey = { kid: "k1", secret: "auth-previous-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
const keyring: Keyring = { current: KEY_CURRENT, previous: KEY_PREVIOUS };

/** The exact value EVERY failure mode must return — 403, no body (§5.6 / §5.16). */
const DENY = { authorized: false, status: 403, code: "SAMO-AUTHZ-001" } as const;

/** Deterministic LCG so a fuzz failure reproduces from the logged seed. */
function lcg(seed: number) {
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000;
  const str = (n: number) =>
    Array.from({ length: n }, () => String.fromCharCode(32 + Math.floor(next() * 94))).join("");
  return { next, str };
}

// =============================================================================
// 1. Credential-resolution invariants — no DB, always run.
// =============================================================================
describe("authorizeCall — credential resolution (no DB)", () => {
  /** A `tx` that records whether the gate ever touched tenant context. */
  function makeTxSpy() {
    let touched = false;
    const fn = (..._args: unknown[]) => {
      touched = true;
      return Promise.resolve([] as unknown[]);
    };
    (fn as unknown as { unsafe: unknown }).unsafe = (..._a: unknown[]) => {
      touched = true;
      return Promise.resolve([] as unknown[]);
    };
    return { tx: fn as unknown as SQL, touched: () => touched };
  }

  const nullDeps: AuthorizeDeps = {
    keyring,
    lookupSession: async () => null,
    lookupCallTenant: async () => null,
  };

  it("denies, and never touches tenant context, when no credential is present", async () => {
    const { tx, touched } = makeTxSpy();
    const res = await authorizeCall(tx, { callId: randomUUID() }, nullDeps);
    expect(res).toEqual(DENY);
    expect(touched()).toBe(false);
  });

  it("denies an empty callId even when a token-shaped string is present", async () => {
    const { tx } = makeTxSpy();
    expect(await authorizeCall(tx, { callId: "", shareToken: "aaa.bbb" }, nullDeps)).toEqual(DENY);
  });

  it("FUZZ: random/garbage inputs NEVER authorize and NEVER touch tenant context", async () => {
    const seed = 0x9e3779b1;
    const { next, str } = lcg(seed);
    let authorized = 0;
    let everTouched = false;
    const ITER = 500;
    for (let i = 0; i < ITER; i++) {
      const { tx, touched } = makeTxSpy();
      const req: AuthorizeRequest = {
        callId: next() < 0.5 ? str(1 + Math.floor(next() * 40)) : randomUUID(),
        sessionCookie: next() < 0.5 ? str(Math.floor(next() * 30)) : undefined,
        shareToken: next() < 0.5 ? str(Math.floor(next() * 60)) : undefined,
        agentToken: next() < 0.2 ? str(Math.floor(next() * 60)) : undefined,
      };
      const res = await authorizeCall(tx, req, nullDeps);
      if (res.authorized) authorized++;
      if (touched()) everTouched = true;
    }
    console.log(
      `[fuzz/no-db] seed=0x${seed.toString(16)} iterations=${ITER} authorized=${authorized} touchedTenantCtx=${everTouched}`,
    );
    expect(authorized).toBe(0);
    expect(everTouched).toBe(false);
  });
});

// =============================================================================
// 2. DB-backed tenant isolation — real Postgres, real RLS, real verifier.
// =============================================================================
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("authorizeCall — tenant isolation (DB-backed, §5.6 / §6.2 #4)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID(); // tenant A
  const callX = randomUUID(); // tenant A (a SECOND call, to isolate the binding check)
  const callB = randomUUID(); // tenant B

  // The #42 session seam, stubbed: opaque cookie → resolved session.
  const sessions = new Map<string, Session>([
    ["cookie-A", { userId: userA, tenantId: tenantA }],
    ["cookie-B", { userId: userB, tenantId: tenantB }],
  ]);

  const deps: AuthorizeDeps = {
    keyring,
    lookupSession: async (cookie) => sessions.get(cookie) ?? null,
    // Privileged, pre-tenant call→tenant resolver (superuser conn bypasses RLS,
    // exactly like prod's privileged path that runs before tenant context).
    lookupCallTenant: async (id) => {
      try {
        const r = await sql`SELECT tenant_id FROM calls WHERE id = ${id}`;
        return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
      } catch {
        return null; // non-uuid / lookup error → unresolved, never throws into the gate
      }
    },
  };

  /** Run the gate inside the request transaction, as the RLS-bound app role. */
  async function gate(req: AuthorizeRequest, now?: number) {
    return sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      return authorizeCall(tx as unknown as SQL, req, now === undefined ? deps : { ...deps, now });
    });
  }

  async function countTokens(callId: string): Promise<number> {
    const r = await sql`SELECT count(*)::int AS c FROM tokens WHERE call_id = ${callId}`;
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
      (${callA}, ${tenantA}, 'https://meet.google.com/aaa', 'IN_CALL'),
      (${callX}, ${tenantA}, 'https://meet.google.com/xxx', 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://meet.google.com/bbb', 'IN_CALL')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM tokens WHERE call_id IN (${callA}, ${callX}, ${callB})`;
    await sql`DELETE FROM calls  WHERE id IN (${callA}, ${callX}, ${callB})`;
    await sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await sql`DELETE FROM users   WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  // ── Happy paths ──────────────────────────────────────────────────────────
  it("GREEN: valid session → `read` on own-tenant call, with ZERO tokens rows created", async () => {
    const before = await countTokens(callA);
    const res = await gate({ callId: callA, sessionCookie: "cookie-A" });
    expect(res).toEqual({ authorized: true, tenantId: tenantA, callId: callA, scopes: ["read"] });
    const after = await countTokens(callA);
    console.log(`[read/no-token-row] tokens(callA) before=${before} after=${after} (delta=${after - before})`);
    expect(after).toBe(before); // `read` is session-derived — never persisted (§5.7, §6.2 #2)
  });

  it("GREEN: valid share token → `share` scope on its bound call", async () => {
    const { token } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const res = await gate({ callId: callA, shareToken: token });
    expect(res).toEqual({ authorized: true, tenantId: tenantA, callId: callA, scopes: ["share"] });
  });

  it("[v2 seam] an `act:*` agent token authorizes through the SAME gate path", async () => {
    const { token } = await mintToken(sql, { callId: callA, scopes: ["act:chat"], signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const res = await gate({ callId: callA, agentToken: token });
    expect(res).toEqual({ authorized: true, tenantId: tenantA, callId: callA, scopes: ["act:chat"] });
  });

  // ── Adversarial denials (§6.2 #4) ─────────────────────────────────────────
  it("DENY: tenant A's share token used to subscribe to tenant B's call (cross-tenant)", async () => {
    const { token } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    expect(await gate({ callId: callB, shareToken: token })).toEqual(DENY);
  });

  it("DENY: expired share token", async () => {
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    const { token } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 60, now: t0 });
    expect(await gate({ callId: callA, shareToken: token }, t0 + 3600)).toEqual(DENY);
  });

  it("DENY: revoked share token denies within 1 s of revoke (NO verifier cache)", async () => {
    const { token, jti } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    expect(await gate({ callId: callA, shareToken: token })).toEqual({
      authorized: true,
      tenantId: tenantA,
      callId: callA,
      scopes: ["share"],
    });

    const t0 = performance.now();
    expect(await revokeToken(sql, jti)).toBe(true);
    const denied = await gate({ callId: callA, shareToken: token });
    const elapsedMs = performance.now() - t0;
    console.log(
      `[revoke-no-cache] revoke→next-authorize round trip = ${elapsedMs.toFixed(1)} ms; result=${JSON.stringify(denied)}`,
    );
    expect(denied).toEqual(DENY); // took effect on the very next call — no cache
    expect(elapsedMs).toBeLessThan(1000); // ≤ 1 s revoke SLO (§3 Story 2, §6.2 #4)
  });

  it("DENY: token bound to call X used on call Y (same tenant — isolates the binding check)", async () => {
    const { token } = await mintShareToken(sql, { callId: callX, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    expect(await gate({ callId: callA, shareToken: token })).toEqual(DENY);
  });

  it("DENY: no token and no session", async () => {
    expect(await gate({ callId: callA })).toEqual(DENY);
  });

  it("DENY: valid session but call_id not in the session's tenant", async () => {
    expect(await gate({ callId: callB, sessionCookie: "cookie-A" })).toEqual(DENY);
  });

  it("DENY: a correctly-signed but never-persisted token (forgery / cross-rotation replay)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      { kid: "k2", call_id: callA, scopes: ["share"], iat: now, exp: now + 3600, jti: randomUUID() },
      KEY_CURRENT,
    );
    expect(await gate({ callId: callA, shareToken: token })).toEqual(DENY);
  });

  it("FUZZ (DB): random tokens thrown at a REAL call NEVER authorize", async () => {
    const seed = 0x1234abcd;
    const { next, str } = lcg(seed);
    let authorized = 0;
    const ITER = 200;
    for (let i = 0; i < ITER; i++) {
      const a = str(1 + Math.floor(next() * 30));
      const b = str(1 + Math.floor(next() * 30));
      const tok = next() < 0.5 ? `${a}.${b}` : `${a}${b}`;
      const res = await gate({ callId: callA, shareToken: tok });
      if (res.authorized) authorized++;
    }
    console.log(`[fuzz/db] seed=0x${seed.toString(16)} iterations=${ITER} authorized=${authorized}`);
    expect(authorized).toBe(0);
  });
});
