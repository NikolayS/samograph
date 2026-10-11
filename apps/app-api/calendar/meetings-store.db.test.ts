import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { PostgresCalendarConnectionStore } from "./pg-store.ts";

const d = process.env.DATABASE_URL ? describe : describe.skip;

d("calendar meetings cache query", () => {
  let sql: ReturnType<typeof connect>;
  const users: string[] = [];
  beforeAll(async () => { sql = connect(); await migrate(sql); });
  afterAll(async () => { for (const id of users) await sql`DELETE FROM users WHERE id=${id}`; await sql.close(); });

  it("is tenant-RLS scoped, excludes ended rows, orders starts_at/id, and limits exactly", async () => {
    const user = randomUUID(), tenant = randomUUID(), otherUser = randomUUID(), otherTenant = randomUUID();
    users.push(user, otherUser);
    await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test`}),(${otherUser},${`${otherUser}@test`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user}),(${otherTenant},${otherUser})`;
    const connection = randomUUID(), otherConnection = randomUUID(), now = new Date("2026-08-21T12:00:00.000Z");
    const bytes = Buffer.alloc(32), iv = Buffer.alloc(12), tag = Buffer.alloc(16);
    await sql`INSERT INTO calendar_connections(id,user_id,tenant_id,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,encryption_key_version,granted_scopes) VALUES (${connection},${user},${tenant},${bytes},${iv},${tag},1,ARRAY['scope']),(${otherConnection},${otherUser},${otherTenant},${bytes},${iv},${tag},1,ARRAY['scope'])`;
    const first = "00000000-0000-4000-8000-000000000001", second = "00000000-0000-4000-8000-000000000002";
    await sql`INSERT INTO calendar_events(id,tenant_id,connection_id,provider_event_id,title,starts_at,ends_at,all_day,attendee_response,meeting_url) VALUES
      (${second},${tenant},${connection},'second','second',${new Date("2026-08-21T13:00:00Z")},${new Date("2026-08-21T14:00:00Z")},false,'accepted','https://zoom.us/j/2'),
      (${first},${tenant},${connection},'first','first',${new Date("2026-08-21T13:00:00Z")},${new Date("2026-08-21T14:00:00Z")},false,'accepted','https://zoom.us/j/1'),
      (${randomUUID()},${tenant},${connection},'ended','ended',${new Date("2026-08-21T10:00:00Z")},${now},false,'accepted','https://zoom.us/j/ended'),
      (${randomUUID()},${otherTenant},${otherConnection},'other','other',${new Date("2026-08-21T12:30:00Z")},${new Date("2026-08-21T14:00:00Z")},false,'accepted','https://zoom.us/j/other')`;
    const snapshot = await new PostgresCalendarConnectionStore(sql).meetings(user, tenant, 1, now);
    expect(snapshot.connection?.status).toBe("connected");
    expect(snapshot.meetings.map((row) => row.id)).toEqual([first]);
  });

  it("returns only timed, linked, non-declined meetings", async () => {
    const user = randomUUID(), tenant = randomUUID(), connection = randomUUID();
    users.push(user);
    await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
    const bytes = Buffer.alloc(32), iv = Buffer.alloc(12), tag = Buffer.alloc(16);
    await sql`INSERT INTO calendar_connections(id,user_id,tenant_id,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,encryption_key_version,granted_scopes) VALUES (${connection},${user},${tenant},${bytes},${iv},${tag},1,ARRAY['scope'])`;
    const allDay = randomUUID(), linkless = randomUUID(), declined = randomUUID(), noResponse = randomUUID(), accepted = randomUUID();
    const startsAt = new Date("2026-08-21T13:00:00Z"), endsAt = new Date("2026-08-21T14:00:00Z");
    await sql`INSERT INTO calendar_events(id,tenant_id,connection_id,provider_event_id,title,starts_at,ends_at,all_day,attendee_response,meeting_url) VALUES
      (${allDay},${tenant},${connection},'all-day','All day',${startsAt},${endsAt},true,'accepted','https://zoom.us/j/all-day'),
      (${linkless},${tenant},${connection},'linkless','Linkless',${startsAt},${endsAt},false,'accepted',NULL),
      (${declined},${tenant},${connection},'declined','Declined',${startsAt},${endsAt},false,'declined','https://zoom.us/j/3'),
      (${noResponse},${tenant},${connection},'no-response','No response',${startsAt},${endsAt},false,NULL,'https://zoom.us/j/5'),
      (${accepted},${tenant},${connection},'accepted','Accepted',${startsAt},${endsAt},false,'accepted','https://zoom.us/j/4')`;

    const snapshot = await new PostgresCalendarConnectionStore(sql).meetings(user, tenant, 20, new Date("2026-08-21T12:00:00Z"));
    expect(snapshot.meetings.map((row) => row.id)).toHaveLength(2);
    expect(snapshot.meetings.map((row) => row.id)).toEqual(expect.arrayContaining([noResponse, accepted]));
  });

  it("shows excluded=true from the durable exclusion table", async () => {
    const user = randomUUID(), tenant = randomUUID(), connection = randomUUID(), eventId = randomUUID(); users.push(user);
    await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
    await sql`INSERT INTO calendar_connections(id,user_id,tenant_id,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,encryption_key_version,granted_scopes) VALUES (${connection},${user},${tenant},${Buffer.alloc(32)},${Buffer.alloc(12)},${Buffer.alloc(16)},1,ARRAY['scope'])`;
    await sql`INSERT INTO calendar_events(id,tenant_id,connection_id,provider_event_id,title,starts_at,ends_at,meeting_url) VALUES (${eventId},${tenant},${connection},'provider-id','Excluded',${new Date("2026-08-21T13:00:00Z")},${new Date("2026-08-21T14:00:00Z")},'https://zoom.us/j/excluded')`;
    await sql`INSERT INTO calendar_event_exclusions(connection_id,provider_event_id,tenant_id) VALUES (${connection},'provider-id',${tenant})`;
    expect((await new PostgresCalendarConnectionStore(sql).meetings(user, tenant, 20, new Date("2026-08-21T12:00:00Z"))).meetings[0]?.autoJoinExcluded).toBe(true);
  });

  it("returns the same not-found results for nonexistent and cross-tenant mutations", async () => {
    const userA = randomUUID(), tenantA = randomUUID(), userB = randomUUID(), tenantB = randomUUID(), connectionB = randomUUID(), eventB = randomUUID();
    users.push(userA, userB);
    await sql`INSERT INTO users(id,email) VALUES (${userA},${`${userA}@test`}),(${userB},${`${userB}@test`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenantA},${userA}),(${tenantB},${userB})`;
    await sql`INSERT INTO calendar_connections(id,user_id,tenant_id,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,encryption_key_version,granted_scopes,auto_join) VALUES (${connectionB},${userB},${tenantB},${Buffer.alloc(32)},${Buffer.alloc(12)},${Buffer.alloc(16)},1,ARRAY['scope'],false)`;
    await sql`INSERT INTO calendar_events(id,tenant_id,connection_id,provider_event_id,starts_at,ends_at) VALUES (${eventB},${tenantB},${connectionB},'tenant-b-event',now(),now()+interval '1 hour')`;
    const store = new PostgresCalendarConnectionStore(sql);
    expect(await store.updateAutoJoin(userA, tenantA, true)).toBeNull();
    expect(await store.updateAutoJoin(userA, tenantA, false)).toBeNull();
    expect(await store.excludeMeeting(userA, tenantA, eventB, true)).toBe(false);
    expect(await store.excludeMeeting(userA, tenantA, randomUUID(), true)).toBe(false);
    expect(await sql`SELECT auto_join FROM calendar_connections WHERE id=${connectionB}` as unknown).toEqual([{ auto_join: false }]);
    expect(await sql`SELECT count(*)::int AS count FROM calendar_event_exclusions WHERE connection_id=${connectionB}` as unknown).toEqual([{ count: 0 }]);
  });
});
