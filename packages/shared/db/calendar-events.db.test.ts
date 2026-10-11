import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, migrate, setTenant } from "./index.ts";
import { PostgresCalendarConnectionStore } from "../../../apps/app-api/calendar/pg-store.ts";
import { normalizeGoogleEvent, type NormalizedCalendarEvent, type SyncConnection } from "../../../apps/app-api/calendar/sync.ts";

const d = process.env.DATABASE_URL ? describe : describe.skip;
d("calendar_events migration", () => {
  let sql: ReturnType<typeof connect>; const users: string[] = [];
  async function owner() {
    const userId = randomUUID(); users.push(userId);
    await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
    const tenant = await sql`INSERT INTO tenants(owner_user_id) VALUES (${userId}) RETURNING id` as unknown as Array<{ id: string }>;
    const connection = await sql`INSERT INTO calendar_connections(user_id,tenant_id,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,encryption_key_version,granted_scopes) VALUES (${userId},${tenant[0].id},${Buffer.from("x")},${Buffer.alloc(12)},${Buffer.alloc(16)},1,ARRAY[]::text[]) RETURNING id` as unknown as Array<{ id: string }>;
    return { userId, tenantId: tenant[0].id, connectionId: connection[0].id };
  }
  async function event(connectionId: string, tenantId: string, providerId: string = randomUUID()) {
    return sql`INSERT INTO calendar_events(tenant_id,connection_id,provider_event_id,starts_at,ends_at) VALUES (${tenantId},${connectionId},${providerId},now(),now()+interval '1 hour') RETURNING id`;
  }
  beforeAll(async () => { sql = connect(); await migrate(sql); });
  afterAll(async () => { for (const id of users) await sql`DELETE FROM users WHERE id=${id}`; await sql.close(); });

  it("enables and forces RLS with the scalar sub-SELECT policy", async () => {
    const posture = await sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='calendar_events'::regclass`;
    const policy = await sql`SELECT qual,with_check FROM pg_policies WHERE tablename='calendar_events' AND policyname='calendar_events_tenant_isolation'`;
    expect(posture).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(String(policy[0].qual)).toContain("( SELECT current_setting('app.tenant_id'::text)");
    expect(String(policy[0].with_check)).toContain("( SELECT current_setting('app.tenant_id'::text)");
  });
  it("protects durable exclusions with the same forced tenant RLS posture", async () => {
    const posture = await sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='calendar_event_exclusions'::regclass`;
    const policy = await sql`SELECT qual,with_check FROM pg_policies WHERE tablename='calendar_event_exclusions' AND policyname='calendar_event_exclusions_tenant_isolation'`;
    expect(posture).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(String(policy[0].qual)).toContain("( SELECT current_setting('app.tenant_id'::text)");
    expect(String(policy[0].with_check)).toContain("( SELECT current_setting('app.tenant_id'::text)");
  });
  it("isolates tenants through the runtime role", async () => {
    const a = await owner(), b = await owner(); await event(a.connectionId, a.tenantId, "a"); await event(b.connectionId, b.tenantId, "b");
    const rows = await sql.begin(async (tx) => { await tx.unsafe("SET LOCAL ROLE samograph_app"); await setTenant(tx, a.tenantId); return tx`SELECT provider_event_id FROM calendar_events WHERE provider_event_id IN ('a','b') ORDER BY provider_event_id`; });
    expect(rows).toEqual([{ provider_event_id: "a" }]);
  });
  it("rejects connection/tenant mismatch and cascades connection deletion", async () => {
    const a = await owner(), b = await owner();
    let errno: string | undefined; try { await event(a.connectionId, b.tenantId); } catch (error) { errno = (error as { errno?: string }).errno; }
    expect(errno).toBe("23503"); await event(a.connectionId, a.tenantId, "cascade"); await sql`DELETE FROM calendar_connections WHERE id=${a.connectionId}`;
    const remaining = await sql`SELECT provider_event_id FROM calendar_events WHERE provider_event_id='cascade'` as unknown as Array<{ provider_event_id: string }>;
    expect(remaining).toEqual([]);
  });

  it("rejects a cross-tenant exclusion connection under the runtime role", async () => {
    const a = await owner(), b = await owner();
    let errno: string | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, a.tenantId);
        await tx`INSERT INTO calendar_event_exclusions(connection_id,provider_event_id,tenant_id)
          VALUES (${b.connectionId},'cross-tenant',${a.tenantId})`;
      });
    } catch (error) { errno = (error as { errno?: string }).errno; }
    expect(errno).toBe("23503");
  });

  it("returns not found for another tenant's event after entering the runtime-role path", async () => {
    const a = await owner(), b = await owner();
    const rows = await event(b.connectionId, b.tenantId, "tenant-b-event") as unknown as Array<{ id: string }>;
    const store = new PostgresCalendarConnectionStore(sql);
    expect(await store.excludeMeeting(a.userId, a.tenantId, rows[0].id, true)).toBe(false);
  });

  it("never lets an older reconciliation overwrite a newer success", async () => {
    const row = await owner(); const store = new PostgresCalendarConnectionStore(sql); const olderConnection = await store.startSync(row.connectionId); const newerConnection = await store.startSync(row.connectionId);
    const normalized = (title: string): NormalizedCalendarEvent => ({ providerEventId: "race", recurringEventId: null, title, organizerEmail: null, startsAt: new Date("2026-08-24T10:00:00Z"), endsAt: new Date("2026-08-24T11:00:00Z"), allDay: false, attendeeResponse: null, meetingUrl: null, meetingProvider: null, sourceUpdatedAt: null });
    const newer = new Date("2026-08-21T12:00:02Z"), older = new Date("2026-08-21T12:00:01Z");
    await store.reconcile(newerConnection!, [normalized("newer")], { windowStart: older, windowEnd: new Date("2026-09-20T00:00:00Z"), syncStartedAt: newer });
    await store.reconcile(olderConnection!, [normalized("older")], { windowStart: older, windowEnd: new Date("2026-09-20T00:00:00Z"), syncStartedAt: older });
    expect(await sql`SELECT title FROM calendar_events WHERE connection_id=${row.connectionId} AND provider_event_id='race'` as unknown).toEqual([{ title: "newer" }]);
    expect(await sql`SELECT last_sync_at FROM calendar_connections WHERE id=${row.connectionId}` as unknown).toEqual([{ last_sync_at: newer }]);
    await store.markFailure(row.connectionId, { syncSeq: olderConnection!.syncSeq, brokenReason: "revoked", at: older });
    expect(await sql`SELECT status,broken_reason,last_sync_at FROM calendar_connections WHERE id=${row.connectionId}` as unknown).toEqual([{ status: "connected", broken_reason: null, last_sync_at: newer }]);
  });

  it("preserves an auto-join exclusion when sync upserts the event", async () => {
    const row = await owner(); const store = new PostgresCalendarConnectionStore(sql);
    const first = await store.startSync(row.connectionId); const second = await store.startSync(row.connectionId);
    const at = new Date("2026-08-21T12:00:00Z"); const bounds = { windowStart: at, windowEnd: new Date("2026-09-20T00:00:00Z"), syncStartedAt: at };
    const normalized = (title: string): NormalizedCalendarEvent => ({ providerEventId: "excluded", recurringEventId: null, title, organizerEmail: null, startsAt: new Date("2026-08-24T10:00:00Z"), endsAt: new Date("2026-08-24T11:00:00Z"), allDay: false, attendeeResponse: "accepted", meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", sourceUpdatedAt: null });
    await store.reconcile(first!, [normalized("before")], bounds);
    const cached = await sql`SELECT id FROM calendar_events WHERE connection_id=${row.connectionId} AND provider_event_id='excluded'` as unknown as Array<{ id: string }>;
    expect(await store.excludeMeeting(row.userId, row.tenantId, cached[0].id, true)).toBe(true);
    await store.reconcile(second!, [normalized("after")], { ...bounds, syncStartedAt: new Date(at.getTime() + 1) });
    expect(await sql`SELECT e.title,(x.connection_id IS NOT NULL) AS excluded FROM calendar_events e LEFT JOIN calendar_event_exclusions x ON x.connection_id=e.connection_id AND x.provider_event_id=e.provider_event_id WHERE e.connection_id=${row.connectionId} AND e.provider_event_id='excluded'` as unknown).toEqual([{ title: "after", excluded: true }]);
  });

  it("preserves an auto-join exclusion when an event is deleted then recreated", async () => {
    const row = await owner(); const store = new PostgresCalendarConnectionStore(sql);
    const at = new Date("2026-08-21T12:00:00Z"); const bounds = { windowStart: at, windowEnd: new Date("2026-09-20T00:00:00Z"), syncStartedAt: at };
    const normalized: NormalizedCalendarEvent = { providerEventId: "recreated", recurringEventId: null, title: "Recreated", organizerEmail: null, startsAt: new Date("2026-08-24T10:00:00Z"), endsAt: new Date("2026-08-24T11:00:00Z"), allDay: false, attendeeResponse: "accepted", meetingUrl: "https://zoom.us/j/recreated", meetingProvider: "zoom", sourceUpdatedAt: null };
    await store.reconcile((await store.startSync(row.connectionId))!, [normalized], bounds);
    const original = await sql`SELECT id FROM calendar_events WHERE connection_id=${row.connectionId} AND provider_event_id='recreated'` as unknown as Array<{ id: string }>;
    expect(await store.excludeMeeting(row.userId, row.tenantId, original[0].id, true)).toBe(true);
    await store.reconcile((await store.startSync(row.connectionId))!, [], { ...bounds, syncStartedAt: new Date(at.getTime() + 1) });
    await store.reconcile((await store.startSync(row.connectionId))!, [normalized], { ...bounds, syncStartedAt: new Date(at.getTime() + 2) });
    const recreated = await sql`SELECT id FROM calendar_events WHERE connection_id=${row.connectionId} AND provider_event_id='recreated'` as unknown as Array<{ id: string }>;
    expect(recreated[0].id).not.toBe(original[0].id);
    expect((await store.meetings(row.userId, row.tenantId, 20, at)).meetings[0]?.autoJoinExcluded).toBe(true);
  });

  it("keeps the newer snapshot when an older reconciliation commits last at the same timestamp", async () => {
    const row = await owner(); const store = new PostgresCalendarConnectionStore(sql);
    const older = await store.startSync(row.connectionId); const newer = await store.startSync(row.connectionId);
    expect([older?.syncSeq, newer?.syncSeq]).toEqual([1n, 2n]);
    const at = new Date("2026-08-21T12:00:00Z");
    const normalized = (title: string): NormalizedCalendarEvent => ({ providerEventId: "race", recurringEventId: null, title, organizerEmail: null, startsAt: new Date("2026-08-24T10:00:00Z"), endsAt: new Date("2026-08-24T11:00:00Z"), allDay: false, attendeeResponse: null, meetingUrl: null, meetingProvider: null, sourceUpdatedAt: null });
    const bounds = { windowStart: at, windowEnd: new Date("2026-09-20T00:00:00Z"), syncStartedAt: at };
    await store.reconcile(newer!, [normalized("newer")], bounds); await store.reconcile(older!, [normalized("older")], bounds);
    expect(await sql`SELECT title FROM calendar_events WHERE connection_id=${row.connectionId} AND provider_event_id='race'` as unknown).toEqual([{ title: "newer" }]);
    expect(await sql`SELECT sync_seq,committed_sync_seq,last_sync_at FROM calendar_connections WHERE id=${row.connectionId}` as unknown).toEqual([{ sync_seq: "2", committed_sync_seq: "2", last_sync_at: at }]);
  });

  it("does not let a pre-reconnect failure break replacement credentials", async () => {
    const row = await owner(); const store = new PostgresCalendarConnectionStore(sql);
    const stale = await store.startSync(row.connectionId);
    const replacement = await store.get(row.userId, row.tenantId);
    await store.save({ ...replacement!, encryptedRefreshToken: Buffer.from("replacement"), grantedScopes: ["calendar.readonly"], connectedAt: new Date("2026-08-21T12:00:01Z"), lastSyncAt: null, lastSyncErrorAt: null, status: "connected" });

    await store.markFailure(row.connectionId, { syncSeq: stale!.syncSeq, brokenReason: "invalid_grant", at: new Date("2026-08-21T12:00:02Z") });
    expect(await sql`SELECT status,broken_reason,last_sync_error_at,sync_seq,committed_sync_seq FROM calendar_connections WHERE id=${row.connectionId}` as unknown).toEqual([{ status: "connected", broken_reason: null, last_sync_error_at: null, sync_seq: "2", committed_sync_seq: "2" }]);
    expect((await store.startSync(row.connectionId))?.syncSeq).toBe(3n);
  });

  it("does not delete a cached all-day row when its event time zone becomes invalid", async () => {
    const row = await owner(); const store = new PostgresCalendarConnectionStore(sql); const first = await store.startSync(row.connectionId); const second = await store.startSync(row.connectionId);
    const at = new Date("2026-08-21T12:00:00Z"); const bounds = { windowStart: at, windowEnd: new Date("2026-09-20T00:00:00Z"), syncStartedAt: at };
    const valid = normalizeGoogleEvent({ id: "all-day", summary: "Retained", start: { date: "2026-08-24", timeZone: "UTC" }, end: { date: "2026-08-25", timeZone: "UTC" } }, "UTC");
    const invalid = normalizeGoogleEvent({ id: "all-day", summary: "Retained", start: { date: "2026-08-24", timeZone: "Invalid/Zone" }, end: { date: "2026-08-25", timeZone: "Invalid/Zone" } }, "Also/Invalid");
    await store.reconcile(first!, [valid!], bounds); await store.reconcile(second!, invalid ? [invalid] : [], bounds);
    expect(await sql`SELECT provider_event_id,title,starts_at,ends_at,all_day FROM calendar_events WHERE connection_id=${row.connectionId}` as unknown).toEqual([{ provider_event_id: "all-day", title: "Retained", starts_at: new Date("2026-08-24T00:00:00.000Z"), ends_at: new Date("2026-08-25T00:00:00.000Z"), all_day: true }]);
  });

  it("reconciles the same overlap window used by Google timeMin and timeMax", async () => {
    const row = await owner(); const store = new PostgresCalendarConnectionStore(sql); const first = await store.startSync(row.connectionId); const second = await store.startSync(row.connectionId);
    const windowStart = new Date("2026-08-21T12:00:00Z"); const bounds = { windowStart, windowEnd: new Date("2026-09-20T12:00:00Z"), syncStartedAt: windowStart };
    const inProgress: NormalizedCalendarEvent = { providerEventId: "in-progress", recurringEventId: null, title: "In progress", organizerEmail: null, startsAt: new Date("2026-08-21T11:30:00Z"), endsAt: new Date("2026-08-21T12:30:00Z"), allDay: false, attendeeResponse: null, meetingUrl: null, meetingProvider: null, sourceUpdatedAt: null };
    await store.reconcile(first!, [inProgress], bounds); await store.reconcile(second!, [], bounds);
    expect(await sql`SELECT provider_event_id FROM calendar_events WHERE connection_id=${row.connectionId}` as unknown).toEqual([]);
  });
});
