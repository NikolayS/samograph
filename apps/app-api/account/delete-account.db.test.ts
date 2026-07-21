/**
 * DELETE /account — full ACCOUNT GDPR erasure, DB-backed integration (SPEC §5.14,
 * §5.10, §5.6, §8). The owner erases their ENTIRE tenant: every call's
 * `transcripts`, capability/share `tokens`, and `workers` rows are purged, each
 * call's Recall recording is deleted (a still-LIVE bot force-left FIRST), audit
 * DETAIL is purged, ALL sessions are revoked, a confirmation email is sent via
 * the EmailSender fake, a single `audit_log(action='account_deleted')` tombstone
 * is written, and the tenant is MARKED DELETED so every subsequent request 401s
 * + clears the cookie (reusing the #159 deleted-tenant path).
 *
 * Reuses #201's per-call cascade+Recall-delete across ALL the tenant's calls, the
 * #50 db client, and the same `samograph_app` RLS role every tenant-scoped route
 * runs under — so the erasure is CONFINED to the caller's tenant by RLS, proven
 * below: a SECOND tenant's data (counts asserted before/after) is UNTOUCHED.
 *
 * Runs against the CI ephemeral Postgres with the REAL migrations + REAL RLS (no
 * mocks; §6.1) and skips cleanly when DATABASE_URL is unset. Strict red/green
 * TDD: written BEFORE the DELETE /account handler exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import { InMemoryEmailSender } from "../auth/email.ts";
import { createAccountHandler } from "./http.ts";
import { createCallsHandler } from "../calls/http.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "delete-account-db-test-session-secret-ffffffffffffffff";

/**
 * Records every Recall act the account-erase flow triggers, in ORDER. `leave`
 * additionally snapshots whether the call row still EXISTS at leave time (read as
 * superuser) per bot — how the live-call test proves a bot is force-left BEFORE
 * its row is purged (an ordering assertion a call-count cannot make).
 */
function makeRecallSpy(sql: ReturnType<typeof connect>) {
  const leave: string[] = [];
  const deleteRecording: string[] = [];
  const order: string[] = [];
  const aliveAtLeave: Record<string, boolean> = {};
  const recall = {
    async leave(botId: string): Promise<void> {
      leave.push(botId);
      order.push(`leave:${botId}`);
      const r = (await sql`SELECT count(*)::int AS c FROM calls WHERE recall_bot_id = ${botId}`) as unknown as Array<{ c: number }>;
      aliveAtLeave[botId] = r[0].c > 0;
    },
    async deleteRecording(botId: string): Promise<void> {
      deleteRecording.push(botId);
      order.push(`del:${botId}`);
    },
  };
  return { recall, leave, deleteRecording, order, aliveAtLeave };
}

d("DELETE /account — full account GDPR erasure (§5.14, RLS-enforced §5.10)", () => {
  let sql: ReturnType<typeof connect>;
  const createdUsers: string[] = [];

  const SESSION_IAT = Date.now();

  function req(method: string, path: string, opts: { cookie?: string } = {}): Request {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
    return new Request(`http://app-api.local${path}`, { method, headers });
  }

  /** Insert a fresh user + tenant and return its ids + signed owner cookie. */
  async function freshOwner(): Promise<{ userId: string; tenantId: string; email: string; cookie: string }> {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const email = `${userId}@acct.test`;
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    createdUsers.push(userId);
    const cookie = signSession({ userId, tenantId, iat: SESSION_IAT }, SESSION_SECRET);
    return { userId, tenantId, email, cookie };
  }

  /** Seed a fully-populated call (transcripts + a share token + a worker). */
  async function seedCall(opts: { tenantId: string; botId: string; status: string }): Promise<string> {
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

  async function count(table: string, where: string, arg: string): Promise<number> {
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS c FROM ${table} WHERE ${where} = $1`,
      [arg],
    )) as unknown as Array<{ c: number }>;
    return rows[0].c;
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    for (const userId of createdUsers) {
      await sql`DELETE FROM users WHERE id = ${userId}`;
    }
    await sql.close();
  });

  // ── (a) Owner erases the account → ALL data purged + Recall-delete per call +
  //        confirmation email + account_deleted tombstone ───────────────────────
  it("owner DELETE /account purges every call's data, calls Recall-delete per call, emails a confirmation, and writes the account_deleted tombstone", async () => {
    const owner = await freshOwner();
    const bot1 = `bot_${randomUUID().slice(0, 8)}`;
    const bot2 = `bot_${randomUUID().slice(0, 8)}`;
    const call1 = await seedCall({ tenantId: owner.tenantId, botId: bot1, status: "ENDED" });
    const call2 = await seedCall({ tenantId: owner.tenantId, botId: bot2, status: "ENDED" });
    const { recall, leave, deleteRecording } = makeRecallSpy(sql);
    const email = new InMemoryEmailSender();
    const handler = createAccountHandler({ sql, sessionSecret: SESSION_SECRET, recall, emailSender: email });

    const res = await handler(req("DELETE", "/account", { cookie: owner.cookie }));
    expect(res.status).toBe(200);
    // The caller's own cookie is cleared immediately (logged out on the spot).
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

    // EVERY call and ALL child data for the tenant are gone (superuser reads).
    for (const callId of [call1, call2]) {
      expect(await count("calls", "id", callId)).toBe(0);
      expect(await count("transcripts", "call_id", callId)).toBe(0);
      expect(await count("tokens", "call_id", callId)).toBe(0);
      expect(await count("workers", "call_id", callId)).toBe(0);
    }

    // Recall recording deleted for EVERY call's bot; no live bot to force-leave.
    expect([...deleteRecording].sort()).toEqual([bot1, bot2].sort());
    expect(leave).toEqual([]);

    // A confirmation email went to the account owner via the EmailSender fake.
    expect(email.sentAccountDeletions.length).toBe(1);
    expect(email.sentAccountDeletions[0].to).toBe(owner.email);

    // Exactly ONE account_deleted tombstone remains as the durable erasure record;
    // per-call audit DETAIL is purged (the account case, §5.14).
    const audit = (await sql`
      SELECT action, actor FROM audit_log WHERE tenant_id = ${owner.tenantId}`) as unknown as Array<{
      action: string;
      actor: string;
    }>;
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe("account_deleted");
    expect(audit[0].actor).toBe(`user:${owner.userId}`);
  });

  // ── (b) RLS NEGATIVE: erasing tenant A does NOT touch tenant B's data ─────────
  it("erasing tenant A leaves tenant B's calls, transcripts, sessions and tenant row UNTOUCHED", async () => {
    const a = await freshOwner();
    const b = await freshOwner();
    const botA = `bot_${randomUUID().slice(0, 8)}`;
    const botB = `bot_${randomUUID().slice(0, 8)}`;
    await seedCall({ tenantId: a.tenantId, botId: botA, status: "ENDED" });
    const bCall = await seedCall({ tenantId: b.tenantId, botId: botB, status: "ENDED" });

    // Snapshot B before A's erasure.
    const bCallsBefore = await count("calls", "tenant_id", b.tenantId);
    const bTxBefore = await count("transcripts", "call_id", bCall);
    expect(bCallsBefore).toBe(1);
    expect(bTxBefore).toBe(2);

    const { recall, deleteRecording } = makeRecallSpy(sql);
    const email = new InMemoryEmailSender();
    const accounts = createAccountHandler({ sql, sessionSecret: SESSION_SECRET, recall, emailSender: email });
    const calls = createCallsHandler({ sql, sessionSecret: SESSION_SECRET, enqueue: () => {}, recall });

    const res = await accounts(req("DELETE", "/account", { cookie: a.cookie }));
    expect(res.status).toBe(200);

    // B's data is entirely intact; only A's bot was erased at Recall.
    expect(await count("calls", "tenant_id", b.tenantId)).toBe(bCallsBefore);
    expect(await count("transcripts", "call_id", bCall)).toBe(bTxBefore);
    expect(await count("tenants", "id", b.tenantId)).toBe(1);
    expect(deleteRecording).toEqual([botA]);
    expect(deleteRecording).not.toContain(botB);

    // B has NO account_deleted tombstone and its owner session still works.
    const bAudit = (await sql`
      SELECT count(*)::int AS c FROM audit_log WHERE tenant_id = ${b.tenantId} AND action = 'account_deleted'`) as unknown as Array<{ c: number }>;
    expect(bAudit[0].c).toBe(0);
    const bList = await calls(req("GET", "/calls", { cookie: b.cookie }));
    expect(bList.status).toBe(200);
  });

  // ── (c) A still-LIVE call force-leaves the bot BEFORE purging the row ──────────
  it("a LIVE (IN_CALL) call is force-left FIRST, then its recording deleted, then purged", async () => {
    const owner = await freshOwner();
    const bot = `bot_${randomUUID().slice(0, 8)}`;
    const callId = await seedCall({ tenantId: owner.tenantId, botId: bot, status: "IN_CALL" });
    const { recall, leave, deleteRecording, order, aliveAtLeave } = makeRecallSpy(sql);
    const email = new InMemoryEmailSender();
    const handler = createAccountHandler({ sql, sessionSecret: SESSION_SECRET, recall, emailSender: email });

    const res = await handler(req("DELETE", "/account", { cookie: owner.cookie }));
    expect(res.status).toBe(200);

    // The bot was force-left, with this call's bot id, BEFORE the row was purged …
    expect(leave).toEqual([bot]);
    expect(aliveAtLeave[bot]).toBe(true);
    // … then its recording deleted (leave strictly precedes delete).
    expect(deleteRecording).toEqual([bot]);
    expect(order).toEqual([`leave:${bot}`, `del:${bot}`]);
    // Row is gone afterward.
    expect(await count("calls", "id", callId)).toBe(0);
  });

  // ── (d) Post-delete the session is invalid across the app (401 + cookie clear) ─
  it("after erasure the owner's session is revoked: a subsequent request 401s + clears the cookie", async () => {
    const owner = await freshOwner();
    const bot = `bot_${randomUUID().slice(0, 8)}`;
    await seedCall({ tenantId: owner.tenantId, botId: bot, status: "ENDED" });
    const { recall } = makeRecallSpy(sql);
    const email = new InMemoryEmailSender();
    const accounts = createAccountHandler({ sql, sessionSecret: SESSION_SECRET, recall, emailSender: email });
    const calls = createCallsHandler({ sql, sessionSecret: SESSION_SECRET, enqueue: () => {}, recall });

    expect((await accounts(req("DELETE", "/account", { cookie: owner.cookie }))).status).toBe(200);

    // The SAME cookie no longer authenticates ANY tenant-scoped route: the #159
    // deleted-tenant path returns 401 SAMO-AUTH-005 + a cleared cookie.
    const after = await calls(req("GET", "/calls", { cookie: owner.cookie }));
    expect(after.status).toBe(401);
    expect(after.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    const body = (await after.json()) as { code?: string };
    expect(body.code).toBe("SAMO-AUTH-005");

    // A second erase attempt with the dead cookie is likewise rejected (idempotent-safe).
    const again = await accounts(req("DELETE", "/account", { cookie: owner.cookie }));
    expect(again.status).toBe(401);
  });

  // ── Unauthenticated erase is refused and touches nothing ──────────────────────
  it("no session → 401 and nothing is erased", async () => {
    const owner = await freshOwner();
    const bot = `bot_${randomUUID().slice(0, 8)}`;
    const callId = await seedCall({ tenantId: owner.tenantId, botId: bot, status: "ENDED" });
    const { recall, deleteRecording } = makeRecallSpy(sql);
    const email = new InMemoryEmailSender();
    const handler = createAccountHandler({ sql, sessionSecret: SESSION_SECRET, recall, emailSender: email });

    const res = await handler(req("DELETE", "/account"));
    expect(res.status).toBe(401);
    expect(await count("calls", "id", callId)).toBe(1);
    expect(deleteRecording).toEqual([]);
    expect(email.sentAccountDeletions.length).toBe(0);
  });
});
