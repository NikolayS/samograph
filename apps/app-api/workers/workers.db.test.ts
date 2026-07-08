/**
 * Worker registration + discovery + invocation — DB-backed integration (§6.2 #9).
 *
 * Runs against the CI ephemeral Postgres with the REAL migrations + REAL RLS (no
 * mocks; SPEC §6.1) and skips cleanly when DATABASE_URL is unset. Proves the four
 * adversarial §6.2 #9 cases end-to-end against a REAL loopback bot-worker:
 *   1. `resolveWorker` resolves a worker by `call_id` ONLY within its own tenant
 *      (RLS-filtered); a cross-tenant resolve returns no row (control: superuser
 *      sees the row, so the exclusion is RLS, not app logic).
 *   2. a stale `workers` row whose process is dead → clean 503 `SAMO-WORKER-503`
 *      (bounded, not a hang).
 *   4. a caller into another tenant's worker via a leaked secret → 403 from the
 *      gate, which runs BEFORE the inter-service auth (the worker is never hit).
 *   5. the authorized happy path drives the real worker's CLI-backed port (2xx).
 *   6. registration persists the secret HASH (never plaintext); heartbeat advances
 *      `last_heartbeat_at`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { connect, setTenant } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import type { Keyring } from "../../../packages/shared/tokens/signing.ts";
import { signSession } from "../auth/session.ts";
import {
  createWorkerHandler,
  inMemoryPresenceStore,
  inMemoryFrameStore,
  registerWorker,
  pgWorkerStore,
  hashWorkerSecret,
  type WorkerRecallPort,
} from "../../bot-worker/index.ts";
import {
  resolveWorker,
  invokeWorker,
  WORKER_UNAVAILABLE,
  type AuthorizeDeps,
} from "./discovery.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "workers-db-test-session-secret-ddddddddddddddddd";
const PLACEHOLDER_KEYRING: Keyring = Object.freeze({
  current: { kid: "__unused__", secret: "__unused__" },
});

/** Spy Recall port — records the chat messages it was asked to post. */
function spyRecall() {
  const seen = { chat: [] as string[], leave: 0 };
  const port: WorkerRecallPort = {
    async sendChat(message) {
      seen.chat.push(message);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    async leaveCall() {
      seen.leave += 1;
      return new Response(null, { status: 200 });
    },
  };
  return { seen, port };
}

d("worker registration + discovery + invocation (§6.2 #9)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID(); // tenant A — gets a LIVE loopback worker
  const callB = randomUUID(); // tenant B — gets a registered worker (for RLS control)
  const callC = randomUUID(); // tenant A — gets a STALE (dead-port) worker

  const SECRET_A = "worker-secret-A-deterministic-aaaa";
  const SECRET_B = "worker-secret-B-deterministic-bbbb";
  const SECRET_C = "worker-secret-C-deterministic-cccc";

  // Sign with a FRESH iat: verifySession (via the gate) checks the wall clock and
  // now enforces the 30-day server-side session TTL (#57), so a 1970 iat would 401.
  const SESSION_IAT = Date.now();
  const cookieA = signSession({ userId: userA, tenantId: tenantA, iat: SESSION_IAT }, SESSION_SECRET);
  const cookieB = signSession({ userId: userB, tenantId: tenantB, iat: SESSION_IAT }, SESSION_SECRET);

  let liveWorker: ReturnType<typeof Bun.serve>;
  let liveRecall: ReturnType<typeof spyRecall>;
  let deadPort = 0;

  /** Gate deps mirroring apps/app-api/calls/http.ts (session → read; RLS scoping). */
  function gateDeps(): AuthorizeDeps {
    return {
      keyring: PLACEHOLDER_KEYRING,
      lookupSession: async (cookie) => {
        const c = (await import("../auth/session.ts")).verifySession(cookie, SESSION_SECRET);
        return c ? { userId: c.userId, tenantId: c.tenantId } : null;
      },
      lookupCallTenant: async (callId) => {
        const r = await sql`SELECT tenant_id FROM calls WHERE id = ${callId}`;
        return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
      },
    };
  }

  const SECRET_FOR: Record<string, string> = {};

  function invokeDeps() {
    return {
      gate: gateDeps(),
      workerSecret: (callId: string) => SECRET_FOR[callId],
      timeoutMs: 1500,
    };
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/a', 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://meet.google.com/b', 'IN_CALL'),
      (${callC}, ${tenantA}, 'https://meet.google.com/c', 'IN_CALL')`;

    // A real loopback bot-worker bound to callA, secret SECRET_A.
    liveRecall = spyRecall();
    const handler = createWorkerHandler({
      callId: callA,
      secret: SECRET_A,
      recall: liveRecall.port,
      presence: inMemoryPresenceStore(),
      frames: inMemoryFrameStore(),
    });
    liveWorker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });

    // A throwaway server to mint a guaranteed-closed port for the stale worker.
    const tmp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    deadPort = tmp.port ?? 0;
    tmp.stop(true);

    // Register all three workers (superuser connection bypasses RLS for the write).
    SECRET_FOR[callA] = SECRET_A;
    SECRET_FOR[callB] = SECRET_B;
    SECRET_FOR[callC] = SECRET_C;
    const store = pgWorkerStore(sql);
    await registerWorker(store, { callId: callA, host: "127.0.0.1", port: liveWorker.port ?? 0, secret: SECRET_A });
    await registerWorker(store, { callId: callB, host: "127.0.0.1", port: 1, secret: SECRET_B });
    await registerWorker(store, { callId: callC, host: "127.0.0.1", port: deadPort, secret: SECRET_C });
  });

  afterAll(async () => {
    liveWorker?.stop(true);
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`; // cascades → calls → workers
    await sql.close();
  });

  // ── #6: registration persists the HASH, never the plaintext ────────────────
  it("registration writes worker_secret_hash = sha256(secret), never the plaintext", async () => {
    const row = await sql`SELECT host, port, worker_secret_hash FROM workers WHERE call_id = ${callA}`;
    expect(row.length).toBe(1);
    expect(row[0].host).toBe("127.0.0.1");
    expect(row[0].port).toBe(liveWorker.port);
    expect(row[0].worker_secret_hash).toBe(hashWorkerSecret(SECRET_A));
    expect(row[0].worker_secret_hash).not.toBe(SECRET_A);
  });

  it("heartbeat advances last_heartbeat_at", async () => {
    // Pin a known-old baseline, then heartbeat and assert it moved forward.
    await sql`UPDATE workers SET last_heartbeat_at = now() - interval '1 hour' WHERE call_id = ${callA}`;
    const before = await sql`SELECT last_heartbeat_at FROM workers WHERE call_id = ${callA}`;
    await pgWorkerStore(sql).heartbeat(callA);
    const after = await sql`SELECT last_heartbeat_at FROM workers WHERE call_id = ${callA}`;
    expect(new Date(after[0].last_heartbeat_at).getTime()).toBeGreaterThan(
      new Date(before[0].last_heartbeat_at).getTime(),
    );
  });

  // ── #1: resolve only own-tenant workers (RLS-filtered) ─────────────────────
  it("resolveWorker resolves callA within tenant A, but NOT across tenants", async () => {
    // Own tenant: the row resolves.
    const mine = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantA);
      return resolveWorker(tx as unknown as SQL, callA);
    });
    expect(mine?.callId).toBe(callA);
    expect(mine?.port).toBe(liveWorker.port);

    // Cross-tenant: tenant A cannot resolve tenant B's worker (callB).
    const cross = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantA);
      return resolveWorker(tx as unknown as SQL, callB);
    });
    expect(cross).toBeNull();

    // CONTROL: a superuser SELECT sees callB's worker row — so the null above is
    // RLS at the samograph_app role, not a missing row.
    const ctl = await sql`SELECT count(*)::int AS c FROM workers WHERE call_id = ${callB}`;
    expect((ctl[0] as { c: number }).c).toBe(1);
  });

  // ── #5: authorized happy path drives the real worker's CLI-backed port ─────
  it("authorized owner → invokeWorker reaches the live worker, posts chat, returns 2xx", async () => {
    const before = liveRecall.seen.chat.length;
    const res = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      return invokeWorker(
        tx as unknown as SQL,
        { callId: callA, sessionCookie: cookieA },
        { method: "POST", verb: "chat", body: { message: "live hello" } },
        invokeDeps(),
      );
    });
    expect(res.status).toBe(200);
    expect(liveRecall.seen.chat.slice(before)).toEqual(["live hello"]);
  });

  // ── #4: cross-tenant via a leaked secret → 403 gate-first, worker untouched ──
  it("tenant B targeting tenant A's call → 403 from the gate, worker NEVER hit", async () => {
    const before = liveRecall.seen.chat.length;
    const res = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      return invokeWorker(
        tx as unknown as SQL,
        { callId: callA, sessionCookie: cookieB }, // tenant B caller
        { method: "POST", verb: "chat", body: { message: "intrusion" } },
        invokeDeps(),
      );
    });
    expect(res.status).toBe(403);
    // Gate-first: even though SECRET_A is known to the invoker, the worker's port
    // never ran for this request.
    expect(liveRecall.seen.chat.length).toBe(before);
  });

  // ── #2: stale row (dead process) → clean, bounded 503 (not a hang) ─────────
  it("a stale worker row whose process is dead → 503 SAMO-WORKER-503, bounded", async () => {
    const started = Date.now();
    const res = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      return invokeWorker(
        tx as unknown as SQL,
        { callId: callC, sessionCookie: cookieA }, // callC is tenant A; owner authorized
        { method: "POST", verb: "chat", body: { message: "anyone home?" } },
        invokeDeps(),
      );
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(WORKER_UNAVAILABLE);
    expect(elapsed).toBeLessThan(5000); // bounded — a refused connection fails fast
  });
});
