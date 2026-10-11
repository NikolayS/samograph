import { describe, expect, it } from "bun:test";
import { GOOGLE_CALENDAR_EVENTS_URL, GOOGLE_CALENDAR_FIELDS } from "../../../apps/app-api/calendar/google-calendar-client.ts";
import { FakeGoogleCalendar } from "./index.ts";

const query = `timeMin=${encodeURIComponent("2026-08-21T00:00:00.000Z")}&timeMax=${encodeURIComponent("2026-08-23T00:00:00.000Z")}&singleEvents=true&orderBy=startTime&showDeleted=false&maxResults=2500&fields=${encodeURIComponent(GOOGLE_CALENDAR_FIELDS)}`;

describe("FakeGoogleCalendar request contract", () => {
  it("rejects non-GET, wrong bearer auth, and malformed required query values", async () => {
    const fake = new FakeGoogleCalendar(); const url = `${GOOGLE_CALENDAR_EVENTS_URL}?${query}`;
    expect((await fake.fetchImpl(url, { method: "POST", headers: { authorization: "Bearer access-token" } })).status).toBe(405);
    expect((await fake.fetchImpl(url, { method: "GET", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fake.fetchImpl(GOOGLE_CALENDAR_EVENTS_URL, { method: "GET", headers: { authorization: "Bearer access-token" } })).status).toBe(400);
  });

  it("uses Google's exclusive event-end timeMin and event-start timeMax bounds", async () => {
    const fake = new FakeGoogleCalendar(); fake.seedEvents([
      { id: "ended-at-min", start: { dateTime: "2026-08-20T22:00:00Z" }, end: { dateTime: "2026-08-21T00:00:00Z" } },
      { id: "in-progress", start: { dateTime: "2026-08-20T23:00:00Z" }, end: { dateTime: "2026-08-21T01:00:00Z" } },
      { id: "inside", start: { dateTime: "2026-08-22T10:00:00Z" }, end: { dateTime: "2026-08-22T11:00:00Z" } },
      { id: "starts-at-max", start: { dateTime: "2026-08-23T00:00:00Z" }, end: { dateTime: "2026-08-23T01:00:00Z" } },
    ]);
    const body = await (await fake.fetchImpl(`${GOOGLE_CALENDAR_EVENTS_URL}?${query}`, { method: "GET", headers: { authorization: "Bearer access-token" } })).json() as { items: Array<{ id: string }> };
    expect(body.items.map((event) => event.id)).toEqual(["in-progress", "inside"]);
  });

  it("rejects a configured timeout with AbortError when its signal aborts", async () => {
    const fake = new FakeGoogleCalendar(); fake.failNextList({ timeout: true }); const controller = new AbortController();
    const pending = fake.fetchImpl(`${GOOGLE_CALENDAR_EVENTS_URL}?${query}`, { method: "GET", headers: { authorization: "Bearer access-token" }, signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
