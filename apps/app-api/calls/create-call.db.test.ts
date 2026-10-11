import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, migrate } from "../../../packages/shared/db/index.ts";
import { setTenant } from "../../../packages/shared/db/client.ts";
import { InMemoryRateLimiter } from "../auth/rate-limit.ts";
import { autoJoinLockKey, createCallForTenant } from "./create-call.ts";

const d = process.env.DATABASE_URL ? describe : describe.skip;

d("createCallForTenant calendar concurrency", () => {
  let setupSql: ReturnType<typeof connect>;
  let firstSql: ReturnType<typeof connect>;
  let secondSql: ReturnType<typeof connect>;
  const userId = randomUUID();
  const tenantId = randomUUID();

  beforeAll(async () => {
    setupSql = connect();
    firstSql = connect();
    secondSql = connect();
    await migrate(setupSql);
    await setupSql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@test.invalid`})`;
    await setupSql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
  });

  afterAll(async () => {
    await setupSql`DELETE FROM users WHERE id=${userId}`;
    await Promise.all([setupSql.close(), firstSql.close(), secondSql.close()]);
  });

  async function holdLockedCall(
    meetingUrl: string,
    source: "manual" | "calendar",
  ): Promise<{ callId: string; commit: () => void; transaction: Promise<unknown> }> {
    let commit!: () => void;
    const held = new Promise<void>((resolve) => { commit = resolve; });
    let ready!: (callId: string) => void;
    const inserted = new Promise<string>((resolve) => { ready = resolve; });

    const transaction = firstSql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${autoJoinLockKey(tenantId, meetingUrl)}))`;
      const rows = source === "manual"
        ? await tx`
          INSERT INTO calls (tenant_id, meeting_url, status, ingest_degraded, source)
          VALUES (${tenantId}, ${meetingUrl}, 'PENDING', false, 'manual')
          RETURNING id`
        : await tx`
          INSERT INTO calls (tenant_id, meeting_url, status, ingest_degraded, source, source_event_id)
          VALUES (${tenantId}, ${meetingUrl}, 'PENDING', false, 'calendar', ${`held:${randomUUID()}`})
          RETURNING id`;
      const callId = String(rows[0]?.id);
      ready(callId);
      await held;
      return callId;
    });

    return { callId: await inserted, commit, transaction };
  }

  async function expectCalendarWaitsForHeldCall(source: "manual" | "calendar"): Promise<void> {
    const meetingUrl = `https://zoom.us/j/${Date.now()}-${randomUUID()}`;
    const held = await holdLockedCall(meetingUrl, source);
    let resolved = false;
    const calendarCreate = createCallForTenant({
      tenantId,
      actor: "calendar-autojoin",
      meetingUrl,
      source: "calendar",
      sourceEventId: `waiting:${randomUUID()}`,
    }, {
      sql: secondSql,
      enqueue: () => {},
      rateLimiter: new InMemoryRateLimiter(),
      now: Date.now,
    }).then((result) => {
      resolved = true;
      return result;
    });

    try {
      await Bun.sleep(300);
      expect(resolved).toBe(false);
    } finally {
      held.commit();
    }

    await held.transaction;
    expect(await calendarCreate).toEqual({ kind: "already_active", callId: held.callId });
  }

  it("waits for a locked manual insert, then sees it as already active", async () => {
    await expectCalendarWaitsForHeldCall("manual");
  });

  it("waits for a locked calendar insert with a different event, then sees it as already active", async () => {
    await expectCalendarWaitsForHeldCall("calendar");
  });

  it("makes a manual create wait for a locked calendar insert, then returns already_active", async () => {
    const meetingUrl = `https://zoom.us/j/${Date.now()}-${randomUUID()}`;
    const held = await holdLockedCall(meetingUrl, "calendar");
    let resolved = false;
    const manualCreate = createCallForTenant({
      tenantId,
      actor: "user:test",
      meetingUrl,
      source: "manual",
    }, {
      sql: secondSql,
      enqueue: () => {},
      rateLimiter: new InMemoryRateLimiter(),
      now: Date.now,
    }).then((result) => { resolved = true; return result; });

    try {
      await Bun.sleep(300);
      expect(resolved).toBe(false);
    } finally {
      held.commit();
    }
    await held.transaction;
    expect(await manualCreate).toEqual({ kind: "already_active", callId: held.callId });
  });

  it("returns already_active for a manual create after a calendar create", async () => {
    const meetingUrl = `https://zoom.us/j/${Date.now()}-${randomUUID()}`;
    const calendar = await createCallForTenant({
      tenantId, actor: "calendar-autojoin", meetingUrl, source: "calendar",
      sourceEventId: `sequential:${randomUUID()}`,
    }, { sql: firstSql, enqueue: () => {}, rateLimiter: new InMemoryRateLimiter(), now: Date.now });
    expect(calendar.kind).toBe("created");

    const manual = await createCallForTenant({ tenantId, actor: "user:test", meetingUrl, source: "manual" }, {
      sql: secondSql, enqueue: () => {}, rateLimiter: new InMemoryRateLimiter(), now: Date.now,
    });
    expect(manual).toEqual({ kind: "already_active", callId: calendar.kind === "created" ? calendar.call.id : "" });
  });

  it("serializes two calendar creates for one tenant and normalized meeting URL", async () => {
    const meetingUrl = `https://zoom.us/j/${Date.now()}`;
    const jobs: string[] = [];
    const create = (sql: ReturnType<typeof connect>, sourceEventId: string) =>
      createCallForTenant({
        tenantId,
        actor: "calendar-autojoin",
        meetingUrl,
        source: "calendar",
        sourceEventId,
      }, {
        sql,
        enqueue: (job) => { jobs.push(job.callId); },
        rateLimiter: new InMemoryRateLimiter(),
        now: Date.now,
      });

    const results = await Promise.all([
      create(firstSql, `first:${randomUUID()}`),
      create(secondSql, `second:${randomUUID()}`),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["already_active", "created"]);
    expect(jobs).toHaveLength(1);
    const rows = await setupSql`SELECT id FROM calls WHERE tenant_id=${tenantId} AND meeting_url=${meetingUrl}`;
    expect(rows).toHaveLength(1);
    const alreadyActive = results.find((result) => result.kind === "already_active");
    expect(alreadyActive?.kind === "already_active" ? alreadyActive.callId : null).toBe(String(rows[0]?.id));
  });
});
