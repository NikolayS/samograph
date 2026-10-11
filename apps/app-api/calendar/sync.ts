import { decryptSecret } from "../../../packages/shared/crypto.ts";
import { validateMeetingUrl } from "../calls/validate.ts";
import { GoogleCalendarFailure, type GoogleCalendarClient, type GoogleCalendarEvent } from "./google-calendar-client.ts";

export type BrokenReason = "invalid_grant" | "revoked" | "scope_missing" | "refresh_failed";
export interface SyncConnection { id: string; userId: string; tenantId: string; encryptedRefreshToken: Buffer; refreshTokenIv: Buffer; refreshTokenTag: Buffer; encryptionKeyVersion: number; status: "connected" | "broken"; syncSeq: bigint; }
export interface NormalizedCalendarEvent { providerEventId: string; recurringEventId: string | null; title: string; organizerEmail: string | null; startsAt: Date; endsAt: Date; allDay: boolean; attendeeResponse: "needsAction" | "declined" | "tentative" | "accepted" | null; meetingUrl: string | null; meetingProvider: "google_meet" | "zoom" | null; sourceUpdatedAt: Date | null; }
export interface CalendarSyncStore {
  startSync(connectionId: string): Promise<SyncConnection | null>;
  reconcile(connection: SyncConnection, events: NormalizedCalendarEvent[], input: { windowStart: Date; windowEnd: Date; syncStartedAt: Date }): Promise<void>;
  markFailure(connectionId: string, input: { syncSeq: bigint; brokenReason: BrokenReason | null; at: Date; retryAfterMs?: number }): Promise<void>;
}
const responses = new Set(["needsAction", "declined", "tentative", "accepted"]);
function date(value: unknown): Date | null { if (typeof value !== "string") return null; const out = new Date(value); return Number.isNaN(out.getTime()) ? null : out; }
function tokens(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.match(/https:\/\/[^\s<>"']+/gi)?.map((token) => token.replace(/[),.;!?\]}]+$/g, "")) ?? [];
}
function meeting(raw: unknown): Pick<NormalizedCalendarEvent, "meetingUrl" | "meetingProvider"> | null {
  for (const token of typeof raw === "string" ? [raw, ...tokens(raw)] : []) {
    let parsed: URL; try { parsed = new URL(token); } catch { continue; }
    if (parsed.username || parsed.password || parsed.hash) continue;
    const result = validateMeetingUrl(token); if (result.ok) return { meetingUrl: result.url, meetingProvider: result.provider === "meet" ? "google_meet" : "zoom" };
  }
  return null;
}
function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}
function zonedMidnight(value: unknown, ...timeZones: unknown[]): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timeZone = timeZones.find(validTimeZone) ?? "UTC";
  const [year, month, day] = value.split("-").map(Number); let instant = Date.UTC(year, month - 1, day);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    for (let i = 0; i < 3; i++) { const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value])); const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)); instant += Date.UTC(year, month - 1, day) - represented; }
    return new Date(instant);
  } catch { return new Date(Date.UTC(year, month - 1, day)); }
}
export function normalizeGoogleEvent(raw: GoogleCalendarEvent, calendarTimeZone: string | null = null): NormalizedCalendarEvent | null {
  if (raw.status === "cancelled" || typeof raw.id !== "string" || !raw.id) return null;
  const start = raw.start as Record<string, unknown> | undefined, end = raw.end as Record<string, unknown> | undefined;
  const allDay = typeof start?.date === "string";
  const startsAt = allDay ? zonedMidnight(start?.date, start?.timeZone, calendarTimeZone, "UTC") : date(start?.dateTime);
  const endsAt = allDay ? zonedMidnight(end?.date, end?.timeZone, calendarTimeZone, "UTC") : date(end?.dateTime);
  if (!startsAt || !endsAt || endsAt < startsAt) return null;
  const attendees = Array.isArray(raw.attendees) ? raw.attendees : [];
  const self = attendees.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).self === true) as Record<string, unknown> | undefined;
  const attendeeResponse = typeof self?.responseStatus === "string" && responses.has(self.responseStatus) ? self.responseStatus as NormalizedCalendarEvent["attendeeResponse"] : null;
  const conference = raw.conferenceData as Record<string, unknown> | undefined;
  const points = Array.isArray(conference?.entryPoints) ? conference.entryPoints : [];
  const selected = points.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).entryPointType === "video").map((item) => meeting((item as Record<string, unknown>).uri)).find(Boolean) ?? meeting(raw.hangoutLink) ?? meeting(raw.location) ?? meeting(raw.description) ?? { meetingUrl: null, meetingProvider: null };
  return { providerEventId: raw.id, recurringEventId: typeof raw.recurringEventId === "string" ? raw.recurringEventId : null, title: typeof raw.summary === "string" ? raw.summary : "", organizerEmail: typeof (raw.organizer as Record<string, unknown> | undefined)?.email === "string" ? (raw.organizer as Record<string, string>).email : null, startsAt, endsAt, allDay, attendeeResponse, ...selected, sourceUpdatedAt: date(raw.updated) };
}
export class CalendarSyncService {
  constructor(readonly deps: { store: CalendarSyncStore; client: GoogleCalendarClient; decryptionKeys: Map<number, Buffer>; clock?: () => number }) {}
  async sync(connectionId: string): Promise<number> {
    const connection = await this.deps.store.startSync(connectionId); if (!connection || connection.status === "broken") return 0;
    const syncStartedAt = new Date((this.deps.clock ?? Date.now)()); const windowEnd = new Date(syncStartedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    try {
      const key = this.deps.decryptionKeys.get(connection.encryptionKeyVersion); if (!key) throw new GoogleCalendarFailure("refresh_failed");
      let refresh: string;
      try { refresh = decryptSecret({ ciphertext: connection.encryptedRefreshToken, iv: connection.refreshTokenIv, tag: connection.refreshTokenTag, keyVersion: connection.encryptionKeyVersion }, key, `samo.calendar.refresh.v1|${connection.id}|${connection.userId}|${connection.tenantId}`); }
      catch { throw new GoogleCalendarFailure("refresh_failed"); }
      let access: string;
      try { access = await this.deps.client.refreshAccessToken(refresh); }
      catch (error) { if (error instanceof GoogleCalendarFailure && ["invalid_grant", "rate_limited", "transient", "malformed", "oversized"].includes(error.kind)) throw error; throw new GoogleCalendarFailure("refresh_failed"); }
      let raw: Awaited<ReturnType<GoogleCalendarClient["listEvents"]>>;
      try { raw = await this.deps.client.listEvents(access, syncStartedAt, windowEnd); }
      catch (error) {
        if (!(error instanceof GoogleCalendarFailure) || (error.kind !== "unauthorized" && error.kind !== "forbidden")) throw error;
        try { access = await this.deps.client.refreshAccessToken(refresh); }
        catch (refreshError) { if (refreshError instanceof GoogleCalendarFailure && ["invalid_grant", "rate_limited", "transient", "malformed", "oversized"].includes(refreshError.kind)) throw refreshError; throw new GoogleCalendarFailure("refresh_failed"); }
        try { raw = await this.deps.client.listEvents(access, syncStartedAt, windowEnd); }
        catch (second) {
          if (second instanceof GoogleCalendarFailure && second.kind === "forbidden") throw new GoogleCalendarFailure("forbidden");
          if (second instanceof GoogleCalendarFailure && second.kind === "unauthorized") throw new GoogleCalendarFailure("unauthorized");
          throw second;
        }
      }
      const events = raw.events.map((event) => normalizeGoogleEvent(event, raw.timeZone)).filter((event): event is NormalizedCalendarEvent => event !== null);
      await this.deps.store.reconcile(connection, events, { windowStart: syncStartedAt, windowEnd, syncStartedAt });
      return events.length;
    } catch (error) {
      const failure = error instanceof GoogleCalendarFailure ? error : new GoogleCalendarFailure("transient");
      const brokenReason: BrokenReason | null = failure.kind === "invalid_grant" ? "invalid_grant" : failure.kind === "forbidden" ? "scope_missing" : failure.kind === "unauthorized" ? "revoked" : null;
      await this.deps.store.markFailure(connectionId, { syncSeq: connection.syncSeq, brokenReason, at: syncStartedAt, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) });
      throw failure;
    }
  }
}
