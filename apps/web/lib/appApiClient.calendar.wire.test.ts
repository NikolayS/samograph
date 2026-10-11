import { afterAll, describe, expect, it } from "bun:test";
import { createHttpAppApiClient } from "./appApiClient.ts";

const seen: Array<{ method: string; path: string; credentials: string | undefined; body: string }> = [];
let response: Response = Response.json({});
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ method: req.method, path: `${url.pathname}${url.search}`, credentials: req.credentials, body: await req.text() });
    return response;
  },
});
const client = createHttpAppApiClient(`http://localhost:${server.port}`);
afterAll(() => server.stop(true));

describe("calendar AppApiClient wire contract", () => {
  it("maps GET /calendar/status strictly", async () => {
    seen.length = 0;
    response = Response.json({ provider: "google", state: "connected", connected_at: "2026-08-20T18:30:00.000Z", last_sync_at: "2026-08-20T18:35:00.000Z", last_sync_error_at: null });
    expect(await client.getCalendarStatus()).toEqual({ provider: "google", state: "connected", connectedAt: "2026-08-20T18:30:00.000Z", lastSyncAt: "2026-08-20T18:35:00.000Z", lastSyncErrorAt: null });
    expect(seen).toEqual([{ method: "GET", path: "/calendar/status", credentials: "include", body: "" }]);
  });

  it("maps the nested error code on a broken calendar status", async () => {
    response = Response.json({ provider: "google", state: "broken", connected_at: "2026-08-20T18:30:00.000Z", last_sync_at: null, last_sync_error_at: "2026-08-20T18:35:00.000Z", error: { code: "SAMO-CALENDAR-005" } });
    expect(await client.getCalendarStatus()).toEqual({ provider: "google", state: "broken", connectedAt: "2026-08-20T18:30:00.000Z", lastSyncAt: null, lastSyncErrorAt: "2026-08-20T18:35:00.000Z", errorCode: "SAMO-CALENDAR-005" });
  });

  it("does not synthesize an error code for a broken calendar status", async () => {
    response = Response.json({ provider: "google", state: "broken", connected_at: "2026-08-20T18:30:00.000Z", last_sync_at: null, last_sync_error_at: null });
    expect(await client.getCalendarStatus()).toEqual({ provider: "google", state: "broken", connectedAt: "2026-08-20T18:30:00.000Z", lastSyncAt: null, lastSyncErrorAt: null });
  });

  it("POSTs an empty JSON body and maps authorization_url", async () => {
    seen.length = 0;
    response = Response.json({ authorization_url: "https://accounts.google.test/consent" });
    expect(await client.startCalendarConnect()).toEqual({ authorizationUrl: "https://accounts.google.test/consent" });
    expect(seen).toEqual([{ method: "POST", path: "/calendar/connect/start", credentials: "include", body: "{}" }]);
  });

  it("DELETEs the calendar connection with no body", async () => {
    seen.length = 0;
    response = new Response(null, { status: 204 });
    await client.disconnectCalendar();
    expect(seen).toEqual([{ method: "DELETE", path: "/calendar/connection", credentials: "include", body: "" }]);
  });

  it("GETs the exact limit query, maps rows, and drops malformed rows", async () => {
    seen.length = 0;
    response = Response.json({ connection_state: "connected", last_sync_at: null, meetings: [
      { id: "event-1", title: "Planning", starts_at: "2026-08-21T17:00:00.000Z", ends_at: "2026-08-21T17:30:00.000Z", all_day: false, meeting_url: "https://meet.google.com/abc-defg-hij", meeting_provider: "google_meet", organizer_email: null, attendee_response: "accepted" },
      { id: 7, title: "bad" },
    ] });
    expect(await client.listCalendarMeetings(20)).toEqual({ connectionState: "connected", lastSyncAt: null, meetings: [{ id: "event-1", title: "Planning", startsAt: "2026-08-21T17:00:00.000Z", endsAt: "2026-08-21T17:30:00.000Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", organizerEmail: null, attendeeResponse: "accepted" }] });
    expect(seen).toEqual([{ method: "GET", path: "/calendar/meetings?limit=20", credentials: "include", body: "" }]);
  });

  it("maps the nested error code on a broken meetings snapshot", async () => {
    response = Response.json({ connection_state: "broken", meetings: [], last_sync_at: "2026-08-20T18:35:00.000Z", error: { code: "SAMO-CALENDAR-005" } });
    expect(await client.listCalendarMeetings()).toEqual({ connectionState: "broken", meetings: [], lastSyncAt: "2026-08-20T18:35:00.000Z", errorCode: "SAMO-CALENDAR-005" });
  });

  it("does not synthesize an error code for a broken meetings snapshot", async () => {
    response = Response.json({ connection_state: "broken", meetings: [], last_sync_at: null });
    expect(await client.listCalendarMeetings()).toEqual({ connectionState: "broken", meetings: [], lastSyncAt: null });
  });
});
