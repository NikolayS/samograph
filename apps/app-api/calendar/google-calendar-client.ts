import { GOOGLE_TOKEN_URL } from "../auth/google-oauth.ts";

export const GOOGLE_CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
export const GOOGLE_CALENDAR_FIELDS = "nextPageToken,timeZone,items(id,status,summary,organizer(email),attendees(self,responseStatus),start(date,dateTime,timeZone),end(date,dateTime,timeZone),updated,recurringEventId,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),location,description)";
const TIMEOUT_MS = 10_000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ERROR_BODY = 64 * 1024;
const MAX_EVENTS = 10_000;
const DEFINITIVE_PERMISSION_REASONS = new Set(["insufficientpermissions", "accessnotconfigured", "forbidden", "autherror", "domainpolicy"]);
export type GoogleCalendarFailureKind = "invalid_grant" | "unauthorized" | "forbidden" | "refresh_failed" | "rate_limited" | "transient" | "malformed" | "oversized";
export class GoogleCalendarFailure extends Error {
  constructor(readonly kind: GoogleCalendarFailureKind, readonly retryAfterMs?: number) { super(`Google Calendar request failed: ${kind}`); this.name = "GoogleCalendarFailure"; }
}
export type GoogleCalendarEvent = Record<string, unknown> & { id?: unknown };

async function bounded(res: Response, maxBody = MAX_BODY): Promise<Record<string, unknown>> {
  const length = res.headers.get("content-length");
  const declared = length === null ? null : Number(length);
  if (declared !== null && Number.isSafeInteger(declared) && declared >= 0 && declared > maxBody) { await res.body?.cancel(); throw new GoogleCalendarFailure("oversized"); }
  const reader = res.body?.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBody) { await reader.cancel(); throw new GoogleCalendarFailure("oversized"); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed as Record<string, unknown>; }
  catch (error) { if (error instanceof GoogleCalendarFailure) throw error; throw new GoogleCalendarFailure("malformed"); }
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3_600_000, seconds * 1000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.min(3_600_000, Math.max(0, date - Date.now())) : undefined;
}
function errorDetails(value: Record<string, unknown>): { reasons: string[]; status: string | null } {
  const error = value.error && typeof value.error === "object" && !Array.isArray(value.error) ? value.error as Record<string, unknown> : null;
  const errors = Array.isArray(error?.errors) ? error.errors : [];
  return {
    reasons: errors.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).reason === "string" ? [(item as Record<string, string>).reason] : []),
    status: typeof error?.status === "string" ? error.status : null,
  };
}
async function statusFailure(res: Response): Promise<GoogleCalendarFailure | null> {
  if (res.status === 429) return new GoogleCalendarFailure("rate_limited", retryAfter(res.headers.get("retry-after")));
  if (res.status >= 500) return new GoogleCalendarFailure("transient");
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    let value: Record<string, unknown>;
    try { value = await bounded(res, MAX_ERROR_BODY); }
    catch { return new GoogleCalendarFailure(res.status === 401 ? "unauthorized" : "transient", retryAfter(res.headers.get("retry-after"))); }
    if (res.status === 400 && value.error === "invalid_grant") return new GoogleCalendarFailure("invalid_grant");
    const { reasons, status } = errorDetails(value);
    const normalized = reasons.map((reason) => reason.toLowerCase());
    const limited = normalized.some((reason) => reason.includes("quota") || reason.endsWith("limitexceeded")) || status === "RESOURCE_EXHAUSTED";
    if (limited) return new GoogleCalendarFailure("transient", retryAfter(res.headers.get("retry-after")));
    if (res.status === 401) return new GoogleCalendarFailure("unauthorized");
    if (res.status === 403 && normalized.some((reason) => DEFINITIVE_PERMISSION_REASONS.has(reason))) return new GoogleCalendarFailure("forbidden");
    // Unknown 403s stay retryable: retrying is safer than permanently breaking a healthy grant.
    return new GoogleCalendarFailure(res.status === 403 ? "transient" : "unauthorized", retryAfter(res.headers.get("retry-after")));
  }
  return null;
}
export class GoogleCalendarClient {
  readonly #fetch: typeof fetch;
  constructor(readonly opts: { clientId: string; clientSecret: string; fetchImpl?: typeof fetch }) { this.#fetch = opts.fetchImpl ?? fetch; }
  async refreshAccessToken(refreshToken: string): Promise<string> {
    let res: Response;
    try { res = await this.#fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.opts.clientId, client_secret: this.opts.clientSecret }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch { throw new GoogleCalendarFailure("transient"); }
    const classified = await statusFailure(res); if (classified) { if (![400, 401, 403].includes(res.status)) await res.body?.cancel(); throw classified; }
    let value: Record<string, unknown>;
    try { value = await bounded(res); } catch (error) { if (error instanceof GoogleCalendarFailure && error.kind === "oversized") throw error; throw new GoogleCalendarFailure("transient"); }
    if (!res.ok) {
      if (res.status === 400 && value.error === "invalid_grant") throw new GoogleCalendarFailure("invalid_grant");
      throw new GoogleCalendarFailure("unauthorized");
    }
    if (typeof value.access_token !== "string" || !value.access_token) throw new GoogleCalendarFailure("malformed");
    return value.access_token;
  }
  async listEvents(accessToken: string, timeMin: Date, timeMax: Date): Promise<{ events: GoogleCalendarEvent[]; timeZone: string | null }> {
    const all: GoogleCalendarEvent[] = []; let pageToken: string | undefined; let timeZone: string | null = null;
    do {
      const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
      for (const [key, value] of Object.entries({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: "true", orderBy: "startTime", showDeleted: "false", maxResults: "2500", fields: GOOGLE_CALENDAR_FIELDS, ...(pageToken ? { pageToken } : {}) })) url.searchParams.set(key, value);
      let res: Response;
      try { res = await this.#fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
      catch { throw new GoogleCalendarFailure("transient"); }
      const classified = await statusFailure(res); if (classified) { if (![400, 401, 403].includes(res.status)) await res.body?.cancel(); throw classified; }
      if (!res.ok) { await res.body?.cancel(); throw new GoogleCalendarFailure("malformed"); }
      let body: Record<string, unknown>; try { body = await bounded(res); } catch (error) { if (error instanceof GoogleCalendarFailure && error.kind === "oversized") throw error; throw new GoogleCalendarFailure("transient"); }
      if (!Array.isArray(body.items)) throw new GoogleCalendarFailure("transient");
      if (timeZone === null && typeof body.timeZone === "string") timeZone = body.timeZone;
      all.push(...body.items as GoogleCalendarEvent[]); if (all.length > MAX_EVENTS) throw new GoogleCalendarFailure("oversized");
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
    } while (pageToken);
    return { events: all, timeZone };
  }
}
