/**
 * DELETE /calls/:id — per-call GDPR erasure, DB-backed integration (SPEC §5.14,
 * §5.10, §5.6, §8). The owner deletes a single call: its `transcripts`, its
 * capability/share `tokens`, and its `workers` row are purged, the Recall
 * recording is deleted via the Recall port, a still-LIVE bot is force-left FIRST,
 * a `deleted_calls` tombstone `(call_id, deleted_at, deleted_by)` is retained for
 * audit integrity, and an `audit_log(action='call_deleted')` entry is written.
 *
 * Runs against the CI ephemeral Postgres with the REAL migrations + REAL RLS (no
 * mocks; §6.1) and skips cleanly when DATABASE_URL is unset. Reuses the #50 db
 * client, the #55 tenancy gate (`authorizeCall`), and the same `samograph_app`
 * RLS role every tenant-scoped route runs under — so a cross-tenant delete is
 * denied by RLS at the route level (proven below), never by app logic alone.
 *
 * Strict red/green TDD: written BEFORE the DELETE /calls/:id route exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import { createCallsHandler } from "./http.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "delete-db-test-session-secret-eeeeeeeeeeeeeeeeeeee";

/**
 * A recording of every Recall act the delete flow triggers. `leave` additionally
 * snapshots whether the call row STILL EXISTS at leave time (read as superuser),
 * which is how the live-call test proves the bot was force-left BEFORE the row
 * was deleted — an ordering assertion a mere call-count cannot make.
 */
function makeRecallSpy(sql: ReturnType<typeof connect>) {
  const leave: string[] = [];
  const deleteRecording: string[] = [];
  const state: { callAliveAtLeave: boolean | null } = { callAliveAtLeave: null };
  const recall = {
    async leave(botId: string): Promise<void> {
      leave.push(botId);
      const r = (await sql`SELECT count(*)::int AS c FROM calls WHERE recall_bot_id = ${botId}`) as unknown as Array<{ c: number }>;
      state.callAliveAtLeave = r[0].c > 0;
    },
    async deleteRecording(botId: string): Promise<void> {
      deleteRecording.push(botId);
    },
  };
  return { recall, leave, deleteRecording, state };
}

d("DELETE /calls/:id — per-call GDPR erasure (§5.14, RLS-enforced §5.10)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const SESSION_IAT = Date.now();
  const cookieA = signSession({ userId: userA, tenantId: tenantA, iat: SESSION_IAT }, SESSION_SECRET);
  const cookieB = signSession({ userId: userB, tenantId: tenantB, iat: SESSION_IAT }, SESSION_SECRET);

  function req(method: string, path: string, opts: { cookie?: string } = {}): Request {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
    return new Request(`http://app-api.local${path}`, { method, headers });
  }

  /** Seed a fully-populated call (transcripts + a share token + a worker). */
  async function seedCall(opts: {
    tenantId: string;
    botId: string;
    status: string;
  }): Promise<string> {
    const callId = randomUUID();
    await sql`INSERT INTO calls (id, tenant_id, recall_bot_id, meeting_url, status)
      VALUES (${callId}, ${opts.tenantId}, ${opts.botId}, 'https://meet.google.com/abc-defg-hij', ${opts.status}::call_status)`;
    await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text) VALUES
      (${callId}, 1, now(), 'Alice', 'first line'),
      (${callId}, 2, now(), 'Bob', 'second line')`;
    await sql`INSERT INTO tokens (call_id, scopes, kid, jti, expires_at)
      VALUES (${callId}, ARRAY['share']::text[], 'k1', ${`jti_${callId}`}, now() + interval '30 days')`;
    await sql`INSERT INTO workers (call_id, host, port, worker_secret_hash)
      VALUES (${callId}, 'worker.local', 9000, 'deadbeef')`;
    return callId;
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  // ── (a) Owner deletes a call → data purged + Recall-delete + tombstone + audit ─
  it("owner DELETE purges the call, its transcripts/tokens/workers, calls Recall-delete, and writes a tombstone + audit", async () => {
    const botId = `bot_${randomUUID().slice(0, 8)}`;
    const callId = await seedCall({ tenantId: tenantA, botId, status: "ENDED" });
    const { recall, leave, deleteRecording, state } = makeRecallSpy(sql);
    const handler = createCallsHandler({ sql, sessionSecret: SESSION_SECRET, enqueue: () => {}, recall });

    const res = await handler(req("DELETE", `/calls/${callId}`, { cookie: cookieA }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // The call row and ALL of its child data are gone (read as superuser).
    const callRows = await sql`SELECT count(*)::int AS c FROM calls WHERE id = ${callId}`;
    expect((callRows[0] as { c: number }).c).toBe(0);
    const tx = await sql`SELECT count(*)::int AS c FROM transcripts WHERE call_id = ${callId}`;
    expect((tx[0] as { c: number }).c).toBe(0);
    const tok = await sql`SELECT count(*)::int AS c FROM tokens WHERE call_id = ${callId}`;
    expect((tok[0] as { c: number }).c).toBe(0);
    const wk = await sql`SELECT count(*)::int AS c FROM workers WHERE call_id = ${callId}`;
    expect((wk[0] as { c: number }).c).toBe(0);

    // Recall recording deleted for exactly this bot; a terminal call is NOT live,
    // so no force-leave is issued.
    expect(deleteRecording).toEqual([botId]);
    expect(leave).toEqual([]);
    expect(state.callAliveAtLeave).toBeNull();

    // Tombstone retained for audit integrity: (call_id, deleted_at, deleted_by).
    const tomb = (await sql`
      SELECT call_id, tenant_id, deleted_by, deleted_at
      FROM deleted_calls WHERE call_id = ${callId}`) as unknown as Array<{
      call_id: string;
      tenant_id: string;
      deleted_by: string;
      deleted_at: Date;
    }>;
    expect(tomb.length).toBe(1);
    expect(tomb[0].call_id).toBe(callId);
    expect(tomb[0].tenant_id).toBe(tenantA);
    expect(tomb[0].deleted_by).toBe(`user:${userA}`);
    expect(tomb[0].deleted_at).toBeInstanceOf(Date);

    // The deletion itself is an audit_log entry (action + actor/deleted_by). Its
    // own call_id column is nulled by the calls ON DELETE SET NULL FK — the
    // durable call_id record is the tombstone above (§5.14 "retained for audit").
    const audit = (await sql`
      SELECT action, actor, tenant_id
      FROM audit_log WHERE tenant_id = ${tenantA} AND action = 'call_deleted'`) as unknown as Array<{
      action: string;
      actor: string;
      tenant_id: string;
    }>;
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe("call_deleted");
    expect(audit[0].actor).toBe(`user:${userA}`);
    expect(audit[0].tenant_id).toBe(tenantA);
  });

  // ── (b) RLS NEGATIVE: cross-tenant delete → 404, victim's data UNTOUCHED ──────
  it("tenant B DELETE of tenant A's call → 404 bodyless; A's call + transcripts are UNTOUCHED", async () => {
    const botId = `bot_${randomUUID().slice(0, 8)}`;
    const callId = await seedCall({ tenantId: tenantA, botId, status: "IN_CALL" });
    const { recall, leave, deleteRecording } = makeRecallSpy(sql);
    const handler = createCallsHandler({ sql, sessionSecret: SESSION_SECRET, enqueue: () => {}, recall });

    // Tenant B tries to delete tenant A's call: RLS hides it → 404, no existence leak.
    const res = await handler(req("DELETE", `/calls/${callId}`, { cookie: cookieB }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(""); // bodyless — never the "not found" 404 of an absent route

    // No Recall side effects were fired for someone else's bot.
    expect(leave).toEqual([]);
    expect(deleteRecording).toEqual([]);

    // A's call and its transcripts are entirely untouched.
    const callRows = await sql`SELECT count(*)::int AS c FROM calls WHERE id = ${callId}`;
    expect((callRows[0] as { c: number }).c).toBe(1);
    const tx = await sql`SELECT count(*)::int AS c FROM transcripts WHERE call_id = ${callId}`;
    expect((tx[0] as { c: number }).c).toBe(2);
    const tomb = await sql`SELECT count(*)::int AS c FROM deleted_calls WHERE call_id = ${callId}`;
    expect((tomb[0] as { c: number }).c).toBe(0); // no tombstone written

    // Owner A can still delete it (route exists + works for the real owner).
    const ownerRes = await handler(req("DELETE", `/calls/${callId}`, { cookie: cookieA }));
    expect(ownerRes.status).toBe(204);
    const after = await sql`SELECT count(*)::int AS c FROM calls WHERE id = ${callId}`;
    expect((after[0] as { c: number }).c).toBe(0);
  });

  // ── (c) A still-LIVE call force-leaves the bot BEFORE deleting the row ─────────
  it("deleting a LIVE (IN_CALL) call force-leaves the bot FIRST, then purges the row", async () => {
    const botId = `bot_${randomUUID().slice(0, 8)}`;
    const callId = await seedCall({ tenantId: tenantA, botId, status: "IN_CALL" });
    const { recall, leave, deleteRecording, state } = makeRecallSpy(sql);
    const handler = createCallsHandler({ sql, sessionSecret: SESSION_SECRET, enqueue: () => {}, recall });

    const res = await handler(req("DELETE", `/calls/${callId}`, { cookie: cookieA }));
    expect(res.status).toBe(204);

    // The bot was force-left, with this call's bot id …
    expect(leave).toEqual([botId]);
    // … and it happened BEFORE the delete: the call row still existed at leave time.
    expect(state.callAliveAtLeave).toBe(true);
    // The Recall recording is then deleted too.
    expect(deleteRecording).toEqual([botId]);

    // Row is gone afterward.
    const callRows = await sql`SELECT count(*)::int AS c FROM calls WHERE id = ${callId}`;
    expect((callRows[0] as { c: number }).c).toBe(0);
  });

  // ── Unauthenticated / share-credential denials mirror the share DELETE route ──
  it("no session → 401 bodyless and nothing is deleted", async () => {
    const botId = `bot_${randomUUID().slice(0, 8)}`;
    const callId = await seedCall({ tenantId: tenantA, botId, status: "ENDED" });
    const { recall } = makeRecallSpy(sql);
    const handler = createCallsHandler({ sql, sessionSecret: SESSION_SECRET, enqueue: () => {}, recall });

    const res = await handler(req("DELETE", `/calls/${callId}`));
    expect(res.status).toBe(401);
    const callRows = await sql`SELECT count(*)::int AS c FROM calls WHERE id = ${callId}`;
    expect((callRows[0] as { c: number }).c).toBe(1);

    // cleanup
    await sql`DELETE FROM calls WHERE id = ${callId}`;
  });
});
