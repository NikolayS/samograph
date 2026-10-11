import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { tenantActive } from "../auth/owner-session.ts";
import { setTenant } from "../../../packages/shared/db/client.ts";
import { toPgTextArray } from "../../../packages/shared/db/text-array.ts";
import type { CalendarConnection, CalendarConnectionStore, CalendarMeeting, CalendarMeetingsSnapshot } from "./service.ts";
import type { BrokenReason, CalendarSyncStore, NormalizedCalendarEvent, SyncConnection } from "./sync.ts";

type Row = Record<string, unknown>;
function map(row: Row): CalendarConnection {
  return { id: String(row.id), userId: String(row.user_id), tenantId: String(row.tenant_id),
    encryptedRefreshToken: Buffer.from(row.encrypted_refresh_token as Uint8Array), refreshTokenIv: Buffer.from(row.refresh_token_iv as Uint8Array), refreshTokenTag: Buffer.from(row.refresh_token_tag as Uint8Array),
    encryptionKeyVersion: Number(row.encryption_key_version), grantedScopes: row.granted_scopes as string[], status: row.status as "connected" | "broken", autoJoin: Boolean(row.auto_join),
    connectedAt: new Date(row.connected_at as string), lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at as string) : null, lastSyncErrorAt: row.last_sync_error_at ? new Date(row.last_sync_error_at as string) : null };
}
export class PostgresCalendarConnectionStore implements CalendarConnectionStore, CalendarSyncStore {
  constructor(readonly sql: SQL) {}
  async tenantExists(tenantId: string) { return tenantActive(this.sql, tenantId); }
  async get(userId: string, tenantId: string) {
    const rows = await this.sql`SELECT * FROM calendar_connections WHERE user_id=${userId} AND tenant_id=${tenantId} AND provider='google'` as unknown as Row[];
    return rows[0] ? map(rows[0]) : null;
  }
  async save(r: CalendarConnection) {
    await this.sql`INSERT INTO calendar_connections (id,user_id,tenant_id,provider,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,encryption_key_version,granted_scopes,status,broken_reason,connected_at,updated_at,last_sync_at,last_sync_error_at)
      VALUES (${r.id},${r.userId},${r.tenantId},'google',${r.encryptedRefreshToken},${r.refreshTokenIv},${r.refreshTokenTag},${r.encryptionKeyVersion},${toPgTextArray(r.grantedScopes)}::text[],'connected',NULL,${r.connectedAt},${r.connectedAt},NULL,NULL)
      ON CONFLICT (user_id,provider) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, encrypted_refresh_token=EXCLUDED.encrypted_refresh_token, refresh_token_iv=EXCLUDED.refresh_token_iv, refresh_token_tag=EXCLUDED.refresh_token_tag, encryption_key_version=EXCLUDED.encryption_key_version, granted_scopes=EXCLUDED.granted_scopes, status='connected', broken_reason=NULL, connected_at=EXCLUDED.connected_at, updated_at=EXCLUDED.updated_at, last_sync_at=NULL, last_sync_error_at=NULL, sync_seq=calendar_connections.sync_seq+1, committed_sync_seq=calendar_connections.sync_seq+1`;
  }
  async delete(userId: string, tenantId: string) { await this.sql`DELETE FROM calendar_connections WHERE user_id=${userId} AND tenant_id=${tenantId} AND provider='google'`; }
  async updateAutoJoin(userId: string, tenantId: string, autoJoin: boolean) {
    const rows = await this.sql`UPDATE calendar_connections SET auto_join=${autoJoin},updated_at=now() WHERE user_id=${userId} AND tenant_id=${tenantId} AND provider='google' RETURNING *` as unknown as Row[];
    return rows[0] ? map(rows[0]) : null;
  }
  async excludeMeeting(userId: string, tenantId: string, eventId: string, excluded: boolean) {
    const connections = await this.sql`SELECT id FROM calendar_connections WHERE user_id=${userId} AND tenant_id=${tenantId} AND provider='google'` as unknown as Row[];
    if (!connections[0]) return false;
    const rows = await this.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      if (excluded) return tx`WITH target AS (
          SELECT connection_id,provider_event_id,tenant_id FROM calendar_events WHERE id=${eventId} AND connection_id=${String(connections[0].id)}
        ), inserted AS (
          INSERT INTO calendar_event_exclusions(connection_id,provider_event_id,tenant_id)
          SELECT connection_id,provider_event_id,tenant_id FROM target ON CONFLICT DO NOTHING RETURNING connection_id
        ) SELECT EXISTS(SELECT 1 FROM target) AS found`;
      return tx`WITH target AS (
          SELECT connection_id,provider_event_id FROM calendar_events WHERE id=${eventId} AND connection_id=${String(connections[0].id)}
        ), deleted AS (
          DELETE FROM calendar_event_exclusions exclusion USING target
          WHERE exclusion.connection_id=target.connection_id AND exclusion.provider_event_id=target.provider_event_id RETURNING exclusion.connection_id
        ) SELECT EXISTS(SELECT 1 FROM target) AS found`;
    }) as unknown as Array<{ found: boolean }>;
    return rows[0]?.found === true;
  }
  async meetings(userId: string, tenantId: string, limit: number, now: Date): Promise<CalendarMeetingsSnapshot> {
    return this.sql.begin(async (tx) => {
      const connections = await tx`SELECT status,last_sync_at,auto_join FROM calendar_connections WHERE user_id=${userId} AND tenant_id=${tenantId} AND provider='google'` as unknown as Array<{ status: "connected" | "broken"; last_sync_at: string | null; auto_join: boolean }>;
      const connection = connections[0] ? { status: connections[0].status, autoJoin: connections[0].auto_join, lastSyncAt: connections[0].last_sync_at ? new Date(connections[0].last_sync_at) : null } : null;
      if (!connection || connection.status === "broken") return { connection, meetings: [] };
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      const rows = await tx`SELECT e.id,e.title,e.starts_at,e.ends_at,e.all_day,e.meeting_url,e.meeting_provider,e.organizer_email,e.attendee_response,(exclusion.connection_id IS NOT NULL) AS auto_join_excluded
        FROM calendar_events e
        LEFT JOIN calendar_event_exclusions exclusion ON exclusion.connection_id=e.connection_id AND exclusion.provider_event_id=e.provider_event_id
        WHERE e.ends_at>${now} AND e.meeting_url IS NOT NULL AND NOT e.all_day AND e.attendee_response IS DISTINCT FROM 'declined' ORDER BY e.starts_at,e.id LIMIT ${limit}` as unknown as Row[];
      const meetings: CalendarMeeting[] = rows.map((row) => ({ id: String(row.id), title: String(row.title), startsAt: new Date(row.starts_at as string), endsAt: new Date(row.ends_at as string), allDay: Boolean(row.all_day), meetingUrl: row.meeting_url === null ? null : String(row.meeting_url), meetingProvider: row.meeting_provider as CalendarMeeting["meetingProvider"], organizerEmail: row.organizer_email === null ? null : String(row.organizer_email), attendeeResponse: row.attendee_response as CalendarMeeting["attendeeResponse"], autoJoinExcluded: Boolean(row.auto_join_excluded) }));
      return { connection, meetings };
    });
  }
  async autoJoinCandidates(connectionId: string, tenantId: string, now: Date, from: Date, to: Date) {
    return this.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      const rows = await tx`SELECT provider_event_id,meeting_url,starts_at,
        NOT EXISTS (
          SELECT 1 FROM calls
          WHERE calls.tenant_id=${tenantId}
            AND calls.meeting_url=calendar_events.meeting_url
            AND calls.created_at >= ${new Date(now.getTime() - 4 * 60 * 60_000)}
            AND calls.status NOT IN ('ENDED','COULD_NOT_JOIN','COULD_NOT_RECORD','BOT_REMOVED')
        ) AS available
        FROM calendar_events WHERE connection_id=${connectionId}
          AND NOT EXISTS (SELECT 1 FROM calendar_event_exclusions exclusion WHERE exclusion.connection_id=calendar_events.connection_id AND exclusion.provider_event_id=calendar_events.provider_event_id)
          AND meeting_url IS NOT NULL AND NOT all_day AND attendee_response IS DISTINCT FROM 'declined' AND starts_at BETWEEN ${from} AND ${to} AND ends_at > ${now} ORDER BY starts_at,provider_event_id` as unknown as Row[];
      return rows.map((row) => ({ providerEventId: String(row.provider_event_id), meetingUrl: String(row.meeting_url), startsAt: new Date(row.starts_at as string), alreadyActive: !Boolean(row.available) }));
    });
  }
  async startSync(connectionId: string): Promise<SyncConnection | null> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${connectionId}))`;
      const rows = await tx`UPDATE calendar_connections SET sync_seq=sync_seq+1 WHERE id=${connectionId} AND status='connected' RETURNING *` as unknown as Row[];
      const row = rows[0] ? map(rows[0]) : null;
      return row ? { id: row.id, userId: row.userId, tenantId: row.tenantId, encryptedRefreshToken: row.encryptedRefreshToken, refreshTokenIv: row.refreshTokenIv, refreshTokenTag: row.refreshTokenTag, encryptionKeyVersion: row.encryptionKeyVersion, status: row.status, syncSeq: BigInt(rows[0].sync_seq as bigint) } : null;
    });
  }
  async reconcile(connection: SyncConnection, events: NormalizedCalendarEvent[], input: { windowStart: Date; windowEnd: Date; syncStartedAt: Date }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${connection.id}))`;
      const state = await tx`SELECT committed_sync_seq FROM calendar_connections WHERE id=${connection.id} FOR UPDATE` as unknown as Array<{ committed_sync_seq: bigint }>;
      if (!state[0] || BigInt(state[0].committed_sync_seq) > connection.syncSeq) return;
      const syncId = randomUUID();
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, connection.tenantId);
      for (const event of events) {
        await tx`INSERT INTO calendar_events (tenant_id,connection_id,provider_event_id,recurring_event_id,title,organizer_email,starts_at,ends_at,all_day,attendee_response,meeting_url,meeting_provider,source_updated_at,sync_id,synced_at,updated_at)
          VALUES (${connection.tenantId},${connection.id},${event.providerEventId},${event.recurringEventId},${event.title},${event.organizerEmail},${event.startsAt},${event.endsAt},${event.allDay},${event.attendeeResponse},${event.meetingUrl},${event.meetingProvider},${event.sourceUpdatedAt},${syncId},${input.syncStartedAt},${input.syncStartedAt})
          ON CONFLICT (connection_id,provider_event_id) DO UPDATE SET recurring_event_id=EXCLUDED.recurring_event_id,title=EXCLUDED.title,organizer_email=EXCLUDED.organizer_email,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,all_day=EXCLUDED.all_day,attendee_response=EXCLUDED.attendee_response,meeting_url=EXCLUDED.meeting_url,meeting_provider=EXCLUDED.meeting_provider,source_updated_at=EXCLUDED.source_updated_at,sync_id=EXCLUDED.sync_id,synced_at=EXCLUDED.synced_at,updated_at=EXCLUDED.updated_at`;
      }
      await tx`DELETE FROM calendar_events WHERE connection_id=${connection.id} AND ends_at > ${input.windowStart} AND starts_at < ${input.windowEnd} AND sync_id <> ${syncId}`;
      await tx`DELETE FROM calendar_events WHERE connection_id=${connection.id} AND ends_at <= ${input.syncStartedAt}`;
      // Credential state is privileged; temporarily return to the transaction owner.
      await tx.unsafe("RESET ROLE");
      await tx`UPDATE calendar_connections SET status='connected',broken_reason=NULL,committed_sync_seq=${connection.syncSeq},last_sync_at=${input.syncStartedAt},updated_at=${input.syncStartedAt} WHERE id=${connection.id}`;
    });
  }
  async markFailure(connectionId: string, input: { syncSeq: bigint; brokenReason: BrokenReason | null; at: Date }): Promise<void> {
    if (input.brokenReason) await this.sql`UPDATE calendar_connections SET status='broken',broken_reason=${input.brokenReason},last_sync_error_at=${input.at},updated_at=${input.at} WHERE id=${connectionId} AND committed_sync_seq<=${input.syncSeq}`;
    else await this.sql`UPDATE calendar_connections SET last_sync_error_at=${input.at},updated_at=${input.at} WHERE id=${connectionId} AND committed_sync_seq<=${input.syncSeq}`;
  }
}
