import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, migrate } from "../../../packages/shared/db/index.ts";
import { InMemoryRateLimiter } from "../auth/rate-limit.ts";
import { createCallForTenant, type CreateCallInput } from "../calls/create-call.ts";
import { PostgresCalendarConnectionStore } from "./pg-store.ts";
import { runCalendarAutoJoin, startCalendarSyncPoller } from "./poller.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const d = process.env.DATABASE_URL ? describe : describe.skip;
d("calendar creation consent ordering", () => {
  let sql: ReturnType<typeof connect>;
  let workerSql: ReturnType<typeof connect>;
  const users: string[] = [];
  beforeAll(async () => { sql = connect(); workerSql = connect(); await migrate(sql); });
  afterAll(async () => {
    for (const user of users) await sql`DELETE FROM users WHERE id=${user}`;
    await Promise.all([sql.close(), workerSql.close()]);
  });

  async function fixture() {
    const user = randomUUID(), tenant = randomUUID(), connection = randomUUID();
    users.push(user);
    await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test.invalid`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
    await sql`INSERT INTO calendar_connections(id,user_id,tenant_id,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,encryption_key_version,granted_scopes,auto_join)
      VALUES (${connection},${user},${tenant},${Buffer.alloc(32)},${Buffer.alloc(12)},${Buffer.alloc(16)},1,ARRAY['scope'],true)`;
    const now = new Date(), end = new Date(now.getTime() + 60 * 60_000);
    const meetingUrl = `https://zoom.us/j/${Date.now()}-${randomUUID()}`;
    const rows = await sql`INSERT INTO calendar_events(tenant_id,connection_id,provider_event_id,starts_at,ends_at,meeting_url)
      VALUES (${tenant},${connection},'event:instance',${now},${end},${meetingUrl}) RETURNING id`;
    const jobs: string[] = [], limiter = new InMemoryRateLimiter();
    const createCall = (input: CreateCallInput) => createCallForTenant(input, {
      sql: workerSql, enqueue: (job) => { jobs.push(job.callId); }, rateLimiter: limiter, now: () => now.getTime(),
    });
    const store = new PostgresCalendarConnectionStore(sql);
    return { user, tenant, connection, eventId: String(rows[0].id), now, meetingUrl, jobs, limiter, createCall, store };
  }

  for (const action of ["disable", "disconnect"] as const) {
    it(`${action} committed while provider sync is pending prevents calls and enqueues`, async () => {
      const f = await fixture(), entered = barrier(), complete = barrier();
      const poller = startCalendarSyncPoller({
        sql: workerSql, clock: () => f.now.getTime(), schedule: () => ({ stop() {} }),
        syncConnection: async (id) => {
          if (id !== f.connection) return;
          entered.release(); await complete.promise;
        },
        autoJoinStore: { candidates: (...args) => f.store.autoJoinCandidates(...args) }, createCall: f.createCall,
      });
      const tick = poller.tick();
      await entered.promise;
      try {
        if (action === "disable") await f.store.updateAutoJoin(f.user, f.tenant, false);
        else await f.store.delete(f.user, f.tenant);
      } finally { complete.release(); }
      await tick;
      expect(await sql`SELECT id FROM calls WHERE tenant_id=${f.tenant}`).toHaveLength(0);
      expect(f.jobs).toEqual([]);
    });
  }

  it("a committed exclusion after candidates load prevents calls and enqueues", async () => {
    const f = await fixture(), loaded = barrier(), proceed = barrier();
    const join = runCalendarAutoJoin({ id: f.connection, tenantId: f.tenant, autoJoin: true }, {
      now: () => f.now, createCall: f.createCall,
      store: { candidates: async (...args) => {
        const candidates = await f.store.autoJoinCandidates(...args);
        expect(candidates.map((event) => event.providerEventId)).toEqual(["event:instance"]);
        loaded.release(); await proceed.promise; return candidates;
      } },
    });
    await loaded.promise;
    try { expect(await f.store.excludeMeeting(f.user, f.tenant, f.eventId, true)).toBe(true); }
    finally { proceed.release(); }
    await join;
    expect(await sql`SELECT id FROM calls WHERE tenant_id=${f.tenant}`).toHaveLength(0);
    expect(f.jobs).toEqual([]);
    // Rejection refunds its independent cost reservation.
    const reservation = await f.limiter.hit(`bot-create:auto:${f.tenant}`, 1, 3_600_000, f.now.getTime());
    expect(reservation.allowed).toBe(true);
  });

  it("disconnect after candidates load prevents calls and enqueues", async () => {
    const f = await fixture();
    const candidates = await f.store.autoJoinCandidates(f.connection, f.tenant, f.now, f.now, f.now);
    await f.store.delete(f.user, f.tenant);
    await runCalendarAutoJoin({ id: f.connection, tenantId: f.tenant, autoJoin: true }, {
      now: () => f.now, createCall: f.createCall, store: { candidates: async () => candidates },
    });
    expect(await sql`SELECT id FROM calls WHERE tenant_id=${f.tenant}`).toHaveLength(0);
    expect(f.jobs).toEqual([]);
  });

  it("creation waits for an in-flight disable transaction and honors its commit", async () => {
    const f = await fixture(), locked = barrier(), commit = barrier();
    const candidates = await f.store.autoJoinCandidates(f.connection, f.tenant, f.now, f.now, f.now);
    const disable = sql.begin(async (tx) => {
      await tx`UPDATE calendar_connections SET auto_join=false WHERE id=${f.connection}`;
      locked.release(); await commit.promise;
    });
    await locked.promise;
    let finished = false;
    const join = runCalendarAutoJoin({ id: f.connection, tenantId: f.tenant, autoJoin: true }, {
      now: () => f.now, createCall: f.createCall, store: { candidates: async () => candidates },
    }).finally(() => { finished = true; });
    try {
      // Observe PostgreSQL's actual lock wait instead of inferring it from a sleep.
      const deadline = Date.now() + 2_000;
      let blocked = false;
      while (!finished && !blocked && Date.now() < deadline) {
        const waits = await sql`SELECT pid FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%calendar_connections%'`;
        blocked = waits.length > 0;
      }
      expect(blocked).toBe(true);
    } finally { commit.release(); await disable; await join; }
    expect(await sql`SELECT id FROM calls WHERE tenant_id=${f.tenant}`).toHaveLength(0);
    expect(f.jobs).toEqual([]);
  });

  it("per-event opt-outs wait for a creation transaction holding consent, even without an exclusion row", async () => {
    const f = await fixture(), locked = barrier(), commit = barrier();
    const creation = workerSql.begin(async (tx) => {
      await tx`SELECT id FROM calendar_connections WHERE id=${f.connection} FOR UPDATE`;
      locked.release(); await commit.promise;
    });
    await locked.promise;
    let finished = false;
    // Removing a nonexistent exclusion has no FK insert to accidentally
    // serialize it: the store must acquire the same consent lock itself.
    const optOut = f.store.excludeMeeting(f.user, f.tenant, f.eventId, false)
      .finally(() => { finished = true; });
    try {
      const deadline = Date.now() + 2_000;
      let blocked = false;
      while (!finished && !blocked && Date.now() < deadline) {
        const waits = await sql`SELECT pid FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%calendar_connections%'`;
        blocked = waits.length > 0;
      }
      expect(blocked).toBe(true);
    } finally { commit.release(); await creation; }
    expect(await optOut).toBe(true);
    expect(f.jobs).toEqual([]);
  });

  it("rejects a broken grant and a connection owned by another tenant", async () => {
    const f = await fixture(), other = await fixture();
    const candidates = await f.store.autoJoinCandidates(f.connection, f.tenant, f.now, f.now, f.now);
    const deps = { now: () => f.now, createCall: f.createCall, store: { candidates: async () => candidates } };
    await runCalendarAutoJoin({ id: f.connection, tenantId: other.tenant, autoJoin: true }, deps);
    await sql`UPDATE calendar_connections SET status='broken',broken_reason='revoked' WHERE id=${f.connection}`;
    await runCalendarAutoJoin({ id: f.connection, tenantId: f.tenant, autoJoin: true }, deps);
    expect(await sql`SELECT id FROM calls WHERE tenant_id IN (${f.tenant},${other.tenant})`).toHaveLength(0);
    expect(f.jobs).toEqual([]);
  });

  it("enabled connected consent creates one call across racing pollers and preserves history after disable", async () => {
    const f = await fixture();
    const deps = { now: () => f.now, createCall: f.createCall, store: { candidates: (...args: Parameters<typeof f.store.autoJoinCandidates>) => f.store.autoJoinCandidates(...args) } };
    await Promise.all([
      runCalendarAutoJoin({ id: f.connection, tenantId: f.tenant, autoJoin: true }, deps),
      runCalendarAutoJoin({ id: f.connection, tenantId: f.tenant, autoJoin: true }, deps),
    ]);
    await f.store.updateAutoJoin(f.user, f.tenant, false);
    const rows = await sql`SELECT id,status,source,source_event_id FROM calls WHERE tenant_id=${f.tenant}`;
    expect(rows).toHaveLength(1);
    expect({ status: rows[0].status, source: rows[0].source, event: rows[0].source_event_id })
      .toEqual({ status: "PENDING", source: "calendar", event: `${f.connection}:event:instance` });
    expect(f.jobs).toEqual([String(rows[0].id)]);
  });
});
