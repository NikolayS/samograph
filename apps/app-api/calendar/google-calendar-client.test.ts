import { describe, expect, it } from "bun:test";
import { FakeGoogleCalendar } from "../../../packages/test-fakes/google-calendar/index.ts";
import { GoogleCalendarClient, GoogleCalendarFailure } from "./google-calendar-client.ts";

describe("GoogleCalendarClient", () => {
  it("refreshes with exact credentials and fetches every page with the exact bounded query", async () => {
    const fake = new FakeGoogleCalendar();
    fake.seedEvents(Array.from({ length: 3 }, (_, i) => ({ id: `event-${i}`, status: "confirmed", summary: `Event ${i}`, start: { dateTime: `2026-08-2${i + 1}T10:00:00Z` }, end: { dateTime: `2026-08-2${i + 1}T11:00:00Z` } })), 2);
    const client = new GoogleCalendarClient({ clientId: "client-id", clientSecret: "client-secret", fetchImpl: fake.fetchImpl });
    const access = await client.refreshAccessToken("refresh-secret");
    const result = await client.listEvents(access, new Date("2026-08-21T00:00:00.000Z"), new Date("2026-09-20T00:00:00.000Z"));
    expect(result.events.map((event) => event.id)).toEqual(["event-0", "event-1", "event-2"]);
    expect(fake.refreshRequests).toEqual([{ grant_type: "refresh_token", refresh_token: "refresh-secret", client_id: "client-id", client_secret: "client-secret" }]);
    expect(fake.listRequests.map((r) => r.query)).toEqual([
      { timeMin: "2026-08-21T00:00:00.000Z", timeMax: "2026-09-20T00:00:00.000Z", singleEvents: "true", orderBy: "startTime", showDeleted: "false", maxResults: "2500", fields: "nextPageToken,timeZone,items(id,status,summary,organizer(email),attendees(self,responseStatus),start(date,dateTime,timeZone),end(date,dateTime,timeZone),updated,recurringEventId,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),location,description)" },
      { timeMin: "2026-08-21T00:00:00.000Z", timeMax: "2026-09-20T00:00:00.000Z", singleEvents: "true", orderBy: "startTime", showDeleted: "false", maxResults: "2500", fields: "nextPageToken,timeZone,items(id,status,summary,organizer(email),attendees(self,responseStatus),start(date,dateTime,timeZone),end(date,dateTime,timeZone),updated,recurringEventId,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),location,description)", pageToken: "page-2" },
    ]);
  });

  it("returns typed safe failures without response bodies", async () => {
    const fake = new FakeGoogleCalendar();
    fake.failNextList({ status: 429, retryAfter: "17", body: "secret google payload" });
    const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: fake.fetchImpl });
    try { await client.listEvents("access-token", new Date(0), new Date(1)); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(GoogleCalendarFailure);
      expect(error).toMatchObject({ kind: "rate_limited", retryAfterMs: 17_000 });
      expect(String(error)).not.toContain("secret google payload");
    }
  });

  it("classifies retryable HTTP status before parsing any response body", async () => {
    for (const [status, body, kind] of [[429, "<html>busy</html>", "rate_limited"], [503, "", "transient"]] as const) {
      const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch });
      await expect(client.listEvents("access", new Date(0), new Date(1))).rejects.toMatchObject({ kind });
    }
  });

  it("cancels a classified error response body before surfacing the failure", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array([115, 101, 99, 114, 101, 116])); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => new Response(body, { status: 503 })) as unknown as typeof fetch });

    try { await client.listEvents("access", new Date(0), new Date(1)); throw new Error("expected failure"); }
    catch (error) {
      expect({ kind: (error as GoogleCalendarFailure).kind, cancelled }).toEqual({ kind: "transient", cancelled: true });
    }
  });

  it("treats malformed 2xx payloads as transient and accepts realistic large pages", async () => {
    const malformed = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => new Response("{")) as unknown as typeof fetch });
    await expect(malformed.listEvents("access", new Date(0), new Date(1))).rejects.toMatchObject({ kind: "transient" });
    const items = Array.from({ length: 400 }, (_, i) => ({ id: `event-${i}`, summary: "x".repeat(300), start: { dateTime: "2026-08-22T10:00:00Z" }, end: { dateTime: "2026-08-22T11:00:00Z" } }));
    const large = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => Response.json({ items, timeZone: "UTC" })) as unknown as typeof fetch });
    expect((await large.listEvents("access", new Date(0), new Date(1))).events).toHaveLength(400);
  });

  it("cancels an oversized streaming body before the producer finishes", async () => {
    const chunk = new Uint8Array(1024 * 1024); let pulls = 0; let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls > 20) controller.close(); else controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => new Response(body)) as unknown as typeof fetch });
    await expect(client.listEvents("access", new Date(0), new Date(1))).rejects.toMatchObject({ kind: "oversized" });
    expect({ cancelled, pulls, bytesProduced: pulls * chunk.byteLength }).toEqual({ cancelled: true, pulls: 9, bytesProduced: 9 * 1024 * 1024 });
  });

  it("rejects a declared oversized body without reading it", async () => {
    let pulls = 0; let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array([123])); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => new Response(body, { headers: { "content-length": String(8 * 1024 * 1024 + 1) } })) as unknown as typeof fetch });
    await expect(client.listEvents("access", new Date(0), new Date(1))).rejects.toMatchObject({ kind: "oversized" });
    expect({ pulls, cancelled }).toEqual({ pulls: 0, cancelled: true });
  });

  it("clamps Retry-After to one hour", async () => {
    const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => new Response("", { status: 429, headers: { "retry-after": "999999" } })) as unknown as typeof fetch });
    await expect(client.listEvents("access", new Date(0), new Date(1))).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 3_600_000 });
  });
});
