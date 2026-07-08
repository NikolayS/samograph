/**
 * `/calls` HTTP adapter — DB-backed integration (SPEC §5.2, §5.6, §5.10, §8).
 *
 * Runs against the CI ephemeral Postgres with the REAL migrations + REAL RLS (no
 * mocks; SPEC §6.1) and skips cleanly when DATABASE_URL is unset. Reuses the #50
 * db client, the #55 tenancy gate (`authorizeCall`), the bot-orchestrator
 * (`orchestrateJoin` + `pgCallStore`), and the deterministic Recall fake — none
 * are reimplemented here.
 *
 * The Sprint-1 exit (§8): "a signed-in user can create a Call row from a URL."
 * Plus the #41-reviewer defence-in-depth flag: every tenant-scoped route tx runs
 * as the NON-superuser `samograph_app` role, so a cross-tenant read is denied by
 * RLS at the route level — proven below by contrasting it with a superuser
 * connection (which BYPASSES RLS and WOULD leak the row).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { connect, setTenant } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { createRecallFake, type RecallFake } from "../../../packages/test-fakes/recall/index.ts";
import {
  orchestrateJoin,
  pgCallStore,
  type RecallClient,
  type CreateBotRequest,
  type OrchestratorJob,
} from "../../bot-orchestrator/index.ts";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import { createCallsHandler } from "./http.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "calls-db-test-session-secret-bbbbbbbbbbbbbbbbbbbb";
const MEET_URL = "https://meet.google.com/abc-defg-hij";
const ZOOM_URL = "https://us02web.zoom.us/j/89012345678";

function fakeRecall(fake: RecallFake): RecallClient {
  return {
    async createBot(req: CreateBotRequest) {
      const { id } = fake.createBot();
      return { id, webhookUrl: req.buildWebhookUrl(id) };
    },
  };
}

d("/calls HTTP adapter (DB-backed, §5.2 / §5.6 / §5.10)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID(); // tenant A, pre-seeded for the read tests
  const callB = randomUUID(); // tenant B, pre-seeded for the isolation tests
  const callFailed = randomUUID(); // tenant A, terminal COULD_NOT_JOIN with a status_reason

  // Sign with a FRESH iat: the handler verifies against the wall clock and now
  // enforces the 30-day server-side session TTL (#57), so a 1970 iat would 401.
  const SESSION_IAT = Date.now();
  const cookieA = signSession({ userId: userA, tenantId: tenantA, iat: SESSION_IAT }, SESSION_SECRET);
  const cookieB = signSession({ userId: userB, tenantId: tenantB, iat: SESSION_IAT }, SESSION_SECRET);

  /** Build a handler with a fresh enqueue spy. */
  function makeHandler() {
    const jobs: OrchestratorJob[] = [];
    const handler = createCallsHandler({
      sql,
      sessionSecret: SESSION_SECRET,
      enqueue: (job) => {
        jobs.push(job);
      },
    });
    return { handler, jobs };
  }

  function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
    return new Request(`http://app-api.local${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  async function countCalls(tenantId: string): Promise<number> {
    const r = await sql`SELECT count(*)::int AS c FROM calls WHERE tenant_id = ${tenantId}`;
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
      (${callA}, ${tenantA}, ${MEET_URL}, 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://zoom.us/j/555', 'IN_CALL')`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, status_reason, ended_at) VALUES
      (${callFailed}, ${tenantA}, ${ZOOM_URL}, 'COULD_NOT_JOIN', 'meeting_not_found', now())`;
  });

  afterAll(async () => {
    // ON DELETE CASCADE from users → tenants → calls → audit_log tears everything down.
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  // ── Create (Sprint-1 exit, §8) ─────────────────────────────────────────────
  it("POST /calls: valid Meet URL → 201 PENDING row in the caller's tenant + audit + enqueue", async () => {
    const { handler, jobs } = makeHandler();
    const before = await countCalls(tenantA);

    const res = await handler(req("POST", "/calls", { cookie: cookieA, body: { meeting_url: MEET_URL } }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("PENDING");
    expect(typeof body.id).toBe("string");

    // The new call row, read back as superuser — EXACT field values (§5.2).
    const rows = await sql`
      SELECT tenant_id, meeting_url, status, ingest_degraded
      FROM calls WHERE id = ${body.id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(tenantA);
    expect(rows[0].meeting_url).toBe(MEET_URL);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].ingest_degraded).toBe(false);

    // Exactly one new call for the tenant.
    expect(await countCalls(tenantA)).toBe(before + 1);

    // Audit-log entry: actor=user:<id>, action=call.create, bound to this call.
    const audit = await sql`
      SELECT actor, action, tenant_id, call_id
      FROM audit_log WHERE call_id = ${body.id}`;
    expect(audit.length).toBe(1);
    expect(audit[0].actor).toBe(`user:${userA}`);
    expect(audit[0].action).toBe("call.create");
    expect(audit[0].tenant_id).toBe(tenantA);

    // The orchestrator seam was enqueued with exactly this call + url.
    expect(jobs).toEqual([{ callId: body.id, meetingUrl: MEET_URL }]);
  });

  it("POST /calls: valid Zoom URL is also accepted → 201 PENDING", async () => {
    const { handler, jobs } = makeHandler();
    const res = await handler(req("POST", "/calls", { cookie: cookieA, body: { meeting_url: ZOOM_URL } }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string }).status).toBe("PENDING");
    expect(jobs.length).toBe(1);
    expect(jobs[0].meetingUrl).toBe(ZOOM_URL);
  });

  it("POST /calls: bad URL → 400 and NO call row is created (row-count unchanged)", async () => {
    const { handler, jobs } = makeHandler();
    const before = await countCalls(tenantA);
    const res = await handler(
      req("POST", "/calls", { cookie: cookieA, body: { meeting_url: "https://example.com/x" } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("SAMO-CALL-URL");
    expect(await countCalls(tenantA)).toBe(before); // no row created
    expect(jobs).toEqual([]);
  });

  it("POST /calls: no session → 401 bodyless and NO call row is created", async () => {
    const { handler } = makeHandler();
    const before = await countCalls(tenantA);
    const res = await handler(req("POST", "/calls", { body: { meeting_url: MEET_URL } }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(await countCalls(tenantA)).toBe(before);
  });

  // ── Stale session for a DELETED tenant (#114, §5.14) ───────────────────────
  // A stateless HMAC cookie outlives its tenant (prod: GDPR deletion; dev: DB
  // recreated). verifySession is pure HMAC, so the signature still checks — but
  // the tenant row is gone. Both tenant-scoped routes must force re-auth (401 +
  // clear-cookie carrying SAMO-AUTH-005) rather than read-empty (GET) or FK-500
  // (POST). A never-inserted tenant/user id is exactly a deleted tenant here.
  const ghostUser = randomUUID();
  const ghostTenant = randomUUID();
  const ghostCookie = signSession(
    { userId: ghostUser, tenantId: ghostTenant, iat: Date.now() },
    SESSION_SECRET,
  );

  it("GET /calls: a deleted-tenant session → 401 SAMO-AUTH-005 + cleared cookie (not empty 200)", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", "/calls", { cookie: ghostCookie }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SAMO-AUTH-005");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("POST /calls: a deleted-tenant session → 401 SAMO-AUTH-005 (not 500) + no row/enqueue", async () => {
    const { handler, jobs } = makeHandler();
    const before = await countCalls(ghostTenant);
    const res = await handler(
      req("POST", "/calls", { cookie: ghostCookie, body: { meeting_url: MEET_URL } }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SAMO-AUTH-005");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain("Max-Age=0");
    expect(await countCalls(ghostTenant)).toBe(before); // no row created
    expect(jobs).toEqual([]); // no orchestrator enqueue
  });

  it("GET /calls: a VALID tenant still lists normally (the fix does not break the happy path)", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", "/calls", { cookie: cookieA }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calls: Array<{ id: string }> };
    expect(body.calls.map((c) => c.id)).toContain(callA);
  });

  // ── Read one (gate-authorized, §5.6) ───────────────────────────────────────
  it("GET /calls/:id: owner reads their own call → 200 with the row", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", `/calls/${callA}`, { cookie: cookieA }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string; meeting_url: string; ingest_degraded: boolean };
    expect(body.id).toBe(callA);
    expect(body.status).toBe("IN_CALL");
    expect(body.meeting_url).toBe(MEET_URL);
    expect(body.ingest_degraded).toBe(false);
  });

  it("GET /calls/:id: a failed call carries status_reason; a healthy call carries null (§5.16)", async () => {
    const { handler } = makeHandler();

    const failed = await handler(req("GET", `/calls/${callFailed}`, { cookie: cookieA }));
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as { status: string; status_reason: string | null };
    expect(failedBody.status).toBe("COULD_NOT_JOIN");
    expect(failedBody.status_reason).toBe("meeting_not_found");

    const ok = await handler(req("GET", `/calls/${callA}`, { cookie: cookieA }));
    const okBody = (await ok.json()) as { status_reason: string | null };
    expect(okBody.status_reason).toBeNull();
  });

  it("GET /calls: list rows carry status_reason (§5.16 — the dashboard shows error details)", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", "/calls", { cookie: cookieA }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      calls: Array<{ id: string; status: string; status_reason: string | null }>;
    };
    const failed = body.calls.find((c) => c.id === callFailed);
    expect(failed).toBeDefined();
    expect(failed?.status).toBe("COULD_NOT_JOIN");
    expect(failed?.status_reason).toBe("meeting_not_found");
    expect(body.calls.find((c) => c.id === callA)?.status_reason).toBeNull();
  });

  it("GET /calls/:id: no session → 403 bodyless (gate DENY)", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", `/calls/${callA}`));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  // ── Cross-tenant isolation, RLS-enforced (§5.6 / §5.10 / #41 reviewer flag) ──
  it("GET /calls/:id: tenant B cannot read tenant A's call → 403 bodyless", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", `/calls/${callA}`, { cookie: cookieB }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  it("the cross-tenant denial is RLS (not app logic): superuser would leak callA, samograph_app does not", async () => {
    // CONTROL — a superuser connection BYPASSES RLS: even with app.tenant_id = B,
    // tenant A's call is visible. If the route ran on such a connection, the gate's
    // membership SELECT would return a row and WRONGLY grant tenant B `read`.
    const leakedAsSuperuser = await sql.begin(async (tx) => {
      await setTenant(tx, tenantB);
      const r = await tx`SELECT count(*)::int AS c FROM calls WHERE id = ${callA}`;
      return (r[0] as { c: number }).c;
    });
    expect(leakedAsSuperuser).toBe(1); // the row IS there — only RLS hides it

    // The route's role: as samograph_app with app.tenant_id = B, RLS hides callA.
    const hiddenAsAppRole = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantB);
      const r = await tx`SELECT count(*)::int AS c FROM calls WHERE id = ${callA}`;
      return (r[0] as { c: number }).c;
    });
    expect(hiddenAsAppRole).toBe(0); // RLS-enforced → therefore the route's 403 above is RLS, not app filtering
  });

  // ── List (RLS-scoped, §5.10) ───────────────────────────────────────────────
  it("GET /calls: lists only the caller's tenant — callA present, callB absent", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", "/calls", { cookie: cookieA }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calls: Array<{ id: string }> };
    const ids = body.calls.map((c) => c.id);
    expect(ids).toContain(callA); // own-tenant call is visible
    expect(ids).not.toContain(callB); // other tenant's call is RLS-hidden

    // CONTROL — a superuser SELECT sees BOTH calls, proving callB really exists and
    // the list's exclusion above is RLS at the route's samograph_app role.
    const allIds = (await sql`SELECT id FROM calls`).map((r: { id: string }) => r.id);
    expect(allIds).toContain(callA);
    expect(allIds).toContain(callB);
  });

  it("GET /calls: no session → 401 bodyless", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", "/calls"));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  // ── End-to-end seam: POST enqueue → orchestrator (Recall FAKE) flips JOINING ─
  it("POST /calls then the enqueued orchestrator (Recall fake) drives PENDING→JOINING", async () => {
    const secret = "calls-itest-ingest-secret-deterministic-0001";
    const expectedHash = createHash("sha256").update(secret).digest("hex");

    const jobs: OrchestratorJob[] = [];
    const handler = createCallsHandler({
      sql,
      sessionSecret: SESSION_SECRET,
      // Wire the seam to the REAL orchestrator over the deterministic Recall fake.
      enqueue: async (job) => {
        jobs.push(job);
        const fake = createRecallFake({ seed: job.callId });
        await orchestrateJoin(job, {
          recall: fakeRecall(fake),
          store: pgCallStore(sql),
          generateSecret: () => secret,
        });
      },
    });

    const res = await handler(req("POST", "/calls", { cookie: cookieA, body: { meeting_url: MEET_URL } }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(jobs).toEqual([{ callId: id, meetingUrl: MEET_URL }]);

    const fake = createRecallFake({ seed: id });
    const row = await sql`
      SELECT status, recall_bot_id, ingest_secret_hash, region FROM calls WHERE id = ${id}`;
    expect(row[0].status).toBe("JOINING");
    expect(row[0].recall_bot_id).toBe(fake.botId);
    expect(row[0].ingest_secret_hash).toBe(expectedHash);
    expect(row[0].region).toBe("us-east");
  });
});
