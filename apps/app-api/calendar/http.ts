import { clientIp } from "../auth/http.ts";
import { AUTH_ERROR_REDIRECT_PATH } from "../auth/google-http.ts";
import { UUID_RE } from "../auth/oauth-state.ts";
import { sessionInvalidResponse } from "../auth/owner-session.ts";
import { buildClearedSessionCookie, SESSION_COOKIE_NAME, verifySession } from "../auth/session.ts";
import { buildClearedCalendarOAuthStateCookie, readCalendarOAuthStateCookie } from "./oauth-state.ts";
import type { CalendarErrorCode, CalendarService } from "./service.ts";
import type { MetricsRegistry } from "../../../packages/shared/observe/registry.ts";

export type CalendarHttpService = Pick<CalendarService, "tenantExists" | "start" | "callback" | "status" | "disconnect" | "meetings" | "updateAutoJoin" | "excludeMeeting">;

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) { const i = part.indexOf("="); if (i >= 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return null;
}
function jsonError(code: CalendarErrorCode, status: number) { return Response.json({ code }, { status, headers: { "cache-control": "no-store" } }); }
function redirect(code?: CalendarErrorCode) {
  return new Response(null, { status: 302, headers: { location: code ? `/settings?calendar_error=${code}` : "/settings?calendar=connected", "set-cookie": buildClearedCalendarOAuthStateCookie(), "cache-control": "no-store" } });
}
function deadSessionCallbackRedirect(): Response {
  const headers = new Headers({ location: AUTH_ERROR_REDIRECT_PATH, "cache-control": "no-store" });
  headers.append("set-cookie", buildClearedSessionCookie());
  headers.append("set-cookie", buildClearedCalendarOAuthStateCookie());
  return new Response(null, { status: 302, headers });
}
async function exactBoolean(req: Request, key: string): Promise<boolean | null> {
  try {
    const body = await req.json() as Record<string, unknown>;
    return body && Object.keys(body).length === 1 && typeof body[key] === "boolean" ? body[key] : null;
  } catch { return null; }
}
function connectionJson(row: Awaited<ReturnType<CalendarHttpService["updateAutoJoin"]>>) {
  return row ? { provider: "google", state: row.status, auto_join: row.autoJoin, connected_at: row.connectedAt.toISOString(), last_sync_at: row.lastSyncAt?.toISOString() ?? null, last_sync_error_at: row.lastSyncErrorAt?.toISOString() ?? null } : null;
}
export function createCalendarHandler(service: CalendarHttpService, sessionSecret: string, now: () => number, metrics?: MetricsRegistry) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url), isCallback = req.method === "GET" && url.pathname === "/calendar/connect/callback";
    const raw = cookie(req, SESSION_COOKIE_NAME), claims = raw ? verifySession(raw, sessionSecret, now()) : null;
    if (!claims) return isCallback ? redirect("SAMO-CALENDAR-003") : new Response(null, { status: 401 });
    if (!(await service.tenantExists(claims.tenantId).catch(() => false))) return isCallback ? deadSessionCallbackRedirect() : sessionInvalidResponse();
    if (req.method === "POST" && url.pathname === "/calendar/connect/start") {
      const result = await service.start({ userId: claims.userId, tenantId: claims.tenantId, ip: clientIp(req) });
      if (result.ok) metrics?.incCalendarConnectStart();
      return result.ok ? Response.json({ authorization_url: result.authorizationUrl }, { headers: { "set-cookie": result.setCookie, "cache-control": "no-store" } }) : jsonError(result.code, result.code === "SAMO-CALENDAR-001" ? 503 : 500);
    }
    if (isCallback) {
      const result = await service.callback({ userId: claims.userId, tenantId: claims.tenantId, ip: clientIp(req), stateCookie: readCalendarOAuthStateCookie(req), params: url.searchParams }).catch(() => ({ ok: false as const, code: "SAMO-CALENDAR-500" as const }));
      metrics?.incCalendarConnectCallback(result.ok ? "ok" : result.code);
      return result.ok ? redirect() : redirect(result.code);
    }
    if (req.method === "GET" && url.pathname === "/calendar/status") {
      const row = await service.status(claims.userId, claims.tenantId);
      if (!row) return Response.json({ provider: "google", state: "not_connected", connected_at: null, last_sync_at: null, last_sync_error_at: null }, { headers: { "cache-control": "no-store" } });
      return Response.json({ provider: "google", state: row.status, auto_join: row.autoJoin, connected_at: row.connectedAt.toISOString(), last_sync_at: row.lastSyncAt?.toISOString() ?? null, last_sync_error_at: row.lastSyncErrorAt?.toISOString() ?? null, ...(row.status === "broken" ? { error: { code: "SAMO-CALENDAR-005" } } : {}) }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "GET" && url.pathname === "/calendar/meetings") {
      const limitValue = url.searchParams.get("limit");
      const rawLimit = Number(limitValue);
      const limit = limitValue !== null && limitValue.trim() !== "" && Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 20;
      const snapshot = await service.meetings(claims.userId, claims.tenantId, limit);
      if (!snapshot.connection) return Response.json({ connection_state: "not_connected", meetings: [], last_sync_at: null }, { headers: { "cache-control": "no-store" } });
      if (snapshot.connection.status === "broken") return Response.json({ connection_state: "broken", meetings: [], last_sync_at: snapshot.connection.lastSyncAt?.toISOString() ?? null, error: { code: "SAMO-CALENDAR-005" } }, { headers: { "cache-control": "no-store" } });
      return Response.json({ connection_state: "connected", auto_join: snapshot.connection.autoJoin, meetings: snapshot.meetings.map((meeting) => ({ id: meeting.id, title: meeting.title, starts_at: meeting.startsAt.toISOString(), ends_at: meeting.endsAt.toISOString(), all_day: meeting.allDay, meeting_url: meeting.meetingUrl, meeting_provider: meeting.meetingProvider, organizer_email: meeting.organizerEmail, attendee_response: meeting.attendeeResponse, auto_join_excluded: meeting.autoJoinExcluded })), last_sync_at: snapshot.connection.lastSyncAt?.toISOString() ?? null }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "PATCH" && url.pathname === "/calendar/connection") {
      const value = await exactBoolean(req, "auto_join"); if (value === null) return new Response(null, { status: 400 });
      const row = await service.updateAutoJoin(claims.userId, claims.tenantId, value);
      return row ? Response.json(connectionJson(row), { headers: { "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
    }
    const meetingMatch = req.method === "PATCH" ? url.pathname.match(/^\/calendar\/meetings\/([^/]*)$/) : null;
    if (meetingMatch) {
      let meetingId: string;
      try { meetingId = decodeURIComponent(meetingMatch[1]); }
      catch { return new Response(null, { status: 400 }); }
      if (!UUID_RE.test(meetingId)) return new Response(null, { status: 400 });
      const value = await exactBoolean(req, "excluded"); if (value === null) return new Response(null, { status: 400 });
      const updated = await service.excludeMeeting(claims.userId, claims.tenantId, meetingId, value);
      return updated ? Response.json({ id: meetingId, excluded: value }, { headers: { "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
    }
    if (req.method === "DELETE" && url.pathname === "/calendar/connection") { const result = await service.disconnect(claims.userId, claims.tenantId); metrics?.incCalendarDisconnect(result); return new Response(null, { status: 204 }); }
    return new Response("not found", { status: 404 });
  };
}
