import { describe, expect, it } from "bun:test";
import { encryptSecret } from "../../../packages/shared/crypto.ts";
import { FakeGoogleCalendar } from "../../../packages/test-fakes/google-calendar/index.ts";
import { GoogleCalendarClient } from "./google-calendar-client.ts";
import { CalendarSyncService, normalizeGoogleEvent, type CalendarSyncStore, type SyncConnection } from "./sync.ts";

const now = new Date("2026-08-21T12:00:00.000Z");
const key = Buffer.alloc(32, 7);
const base = { id: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", tenantId: "00000000-0000-4000-8000-000000000003" };
function fixture() {
  const encrypted = encryptSecret("refresh-token", key, 1, `samo.calendar.refresh.v1|${base.id}|${base.userId}|${base.tenantId}`);
  const connection: SyncConnection = { ...base, encryptedRefreshToken: encrypted.ciphertext, refreshTokenIv: encrypted.iv, refreshTokenTag: encrypted.tag, encryptionKeyVersion: 1, status: "connected", syncSeq: 1n };
  const reconciles: unknown[][] = [], failures: unknown[] = [];
  const store: CalendarSyncStore = { startSync: async () => connection, reconcile: async (_c, events) => { reconciles.push(events); }, markFailure: async (_id, failure) => { failures.push(failure); } };
  const fake = new FakeGoogleCalendar();
  const service = new CalendarSyncService({ store, client: new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: fake.fetchImpl }), decryptionKeys: new Map([[1, key]]), clock: () => now.getTime() });
  return { service, fake, reconciles, failures };
}

function stateFixture() {
  const x = fixture();
  const state: { status: "connected" | "broken"; brokenReason: string | null; lastSyncErrorAt: Date | null; retryAfterMs?: number } = { status: "connected", brokenReason: null, lastSyncErrorAt: null };
  x.service.deps.store.markFailure = async (_id, failure) => {
    state.lastSyncErrorAt = failure.at;
    state.brokenReason = failure.brokenReason;
    if (failure.retryAfterMs !== undefined) state.retryAfterMs = failure.retryAfterMs;
    if (failure.brokenReason !== null) state.status = "broken";
  };
  return { ...x, state };
}

async function failureValue(operation: Promise<unknown>): Promise<{ kind: string; retryAfterMs?: number }> {
  try { await operation; throw new Error("expected failure"); }
  catch (error) {
    if (error instanceof Error && error.message === "expected failure") throw error;
    const failure = error as { kind: string; retryAfterMs?: number };
    return { kind: failure.kind, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
  }
}

describe("CalendarSyncService", () => {
  it("normalizes timed/all-day events and applies meeting URL priority safely", async () => {
    const x = fixture();
    x.fake.seedEvents([
      { id: "timed", status: "confirmed", summary: "Planning", organizer: { email: "owner@example.test" }, attendees: [{ self: true, responseStatus: "accepted" }], start: { dateTime: "2026-08-22T10:00:00-07:00" }, end: { dateTime: "2026-08-22T11:00:00-07:00" }, updated: "2026-08-20T01:02:03Z", recurringEventId: "series", conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] }, hangoutLink: "https://meet.google.com/zzz-yyyy-xxx", location: "https://zoom.us/j/123" },
      { id: "day", status: "confirmed", summary: "Offsite", start: { date: "2026-08-23" }, end: { date: "2026-08-24" }, location: "Join https://zoom.us.evil.example/j/1, or https://acme.zoom.us/j/42.", description: "backup https://meet.google.com/bad and https://zoom.us/j/99" },
      { id: "cancelled", status: "cancelled", start: { dateTime: "2026-08-22T10:00:00Z" }, end: { dateTime: "2026-08-22T11:00:00Z" } },
    ]);
    await x.service.sync(base.id);
    expect(x.reconciles).toHaveLength(1);
    expect(x.reconciles[0]).toEqual([
      { providerEventId: "timed", recurringEventId: "series", title: "Planning", organizerEmail: "owner@example.test", startsAt: new Date("2026-08-22T17:00:00.000Z"), endsAt: new Date("2026-08-22T18:00:00.000Z"), allDay: false, attendeeResponse: "accepted", meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", sourceUpdatedAt: new Date("2026-08-20T01:02:03.000Z") },
      { providerEventId: "day", recurringEventId: null, title: "Offsite", organizerEmail: null, startsAt: new Date("2026-08-23T00:00:00.000Z"), endsAt: new Date("2026-08-24T00:00:00.000Z"), allDay: true, attendeeResponse: null, meetingUrl: "https://acme.zoom.us/j/42", meetingProvider: "zoom", sourceUpdatedAt: null },
    ]);
  });

  it("normalizes all-day midnight in the event or calendar time zone", async () => {
    const x = fixture();
    x.fake.seedEvents([{ id: "day", start: { date: "2026-08-23" }, end: { date: "2026-08-24" } }]);
    x.fake.setCalendarTimeZone("America/Los_Angeles");
    await x.service.sync(base.id);
    expect(x.reconciles[0]?.[0]).toMatchObject({
      startsAt: new Date("2026-08-23T07:00:00.000Z"),
      endsAt: new Date("2026-08-24T07:00:00.000Z"),
      allDay: true,
    });
  });

  it("falls back through valid all-day time zones and preserves exact DST midnights", async () => {
    const cases = [
      { id: "event-invalid", start: { date: "2026-08-23", timeZone: "Mars/Olympus" }, end: { date: "2026-08-24", timeZone: "Mars/Olympus" }, calendar: "America/Los_Angeles", expected: ["2026-08-23T07:00:00.000Z", "2026-08-24T07:00:00.000Z"] },
      { id: "all-invalid", start: { date: "2026-08-23", timeZone: "Invalid/Zone" }, end: { date: "2026-08-24" }, calendar: "Also/Invalid", expected: ["2026-08-23T00:00:00.000Z", "2026-08-24T00:00:00.000Z"] },
      { id: "spring", start: { date: "2026-03-08", timeZone: "America/New_York" }, end: { date: "2026-03-09", timeZone: "America/New_York" }, calendar: "UTC", expected: ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"] },
      { id: "fall", start: { date: "2026-11-01", timeZone: "America/New_York" }, end: { date: "2026-11-02", timeZone: "America/New_York" }, calendar: "UTC", expected: ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"] },
    ];
    for (const value of cases) {
      const event = normalizeGoogleEvent({ id: value.id, start: value.start, end: value.end }, value.calendar);
      expect(event && [event.providerEventId, event.startsAt.toISOString(), event.endsAt.toISOString()]).toEqual([value.id, ...value.expected]);
    }
  });

  it("checks every video entry point and rejects fallback credentials/fragments", async () => {
    const x = fixture();
    x.fake.seedEvents([
      { id: "conference", start: { dateTime: "2026-08-22T10:00:00Z" }, end: { dateTime: "2026-08-22T11:00:00Z" }, conferenceData: { entryPoints: [
        { entryPointType: "video", uri: "https://example.test/nope" },
        { entryPointType: "video", uri: "https://zoom.us/j/222" },
      ] }, hangoutLink: "https://meet.google.com/abc-defg-hij" },
      { id: "strict", start: { dateTime: "2026-08-22T12:00:00Z" }, end: { dateTime: "2026-08-22T13:00:00Z" }, location: "https://user@meet.google.com/abc-defg-hij", description: "https://meet.google.com/abc-defg-hij#fragment" },
    ]);
    await x.service.sync(base.id);
    expect(x.reconciles[0]?.map((event: any) => [event.providerEventId, event.meetingUrl])).toEqual([
      ["conference", "https://zoom.us/j/222"],
      ["strict", null],
    ]);
  });

  it("preserves cache on partial failure and marks invalid_grant broken once", async () => {
    const transient = fixture(); transient.fake.seedEvents([
      { id: "one", status: "confirmed", start: { dateTime: "2026-08-22T10:00:00Z" }, end: { dateTime: "2026-08-22T11:00:00Z" } },
      { id: "two", status: "confirmed", start: { dateTime: "2026-08-23T10:00:00Z" }, end: { dateTime: "2026-08-23T11:00:00Z" } },
    ], 1); transient.fake.failListPage("page-2", { status: 500 });
    await expect(transient.service.sync(base.id)).rejects.toMatchObject({ kind: "transient" });
    expect(transient.reconciles).toEqual([]); expect(transient.failures).toEqual([{ syncSeq: 1n, brokenReason: null, at: now }]);
    const revoked = fixture(); revoked.fake.revokeGrant("refresh-token");
    await expect(revoked.service.sync(base.id)).rejects.toMatchObject({ kind: "invalid_grant" });
    expect(revoked.fake.refreshRequests).toHaveLength(1); expect(revoked.failures).toEqual([{ syncSeq: 1n, brokenReason: "invalid_grant", at: now }]);
  });

  it("keeps the grant connected when a 2xx token refresh response is malformed", async () => {
    const encrypted = encryptSecret("refresh-token", key, 1, `samo.calendar.refresh.v1|${base.id}|${base.userId}|${base.tenantId}`);
    const connection: SyncConnection = { ...base, encryptedRefreshToken: encrypted.ciphertext, refreshTokenIv: encrypted.iv, refreshTokenTag: encrypted.tag, encryptionKeyVersion: 1, status: "connected", syncSeq: 1n };
    const state: { status: "connected" | "broken"; lastSyncErrorAt: Date | null; brokenReason: string | null } = { status: "connected", lastSyncErrorAt: null, brokenReason: null };
    const store: CalendarSyncStore = {
      startSync: async () => connection,
      reconcile: async () => {},
      markFailure: async (_id, failure) => {
        state.lastSyncErrorAt = failure.at;
        state.brokenReason = failure.brokenReason;
        if (failure.brokenReason) state.status = "broken";
      },
    };
    const client = new GoogleCalendarClient({ clientId: "id", clientSecret: "secret", fetchImpl: (async () => Response.json({})) as unknown as typeof fetch });
    const service = new CalendarSyncService({ store, client, decryptionKeys: new Map([[1, key]]), clock: () => now.getTime() });

    await expect(service.sync(base.id)).rejects.toMatchObject({ kind: "malformed" });
    expect(state).toEqual({ status: "connected", lastSyncErrorAt: now, brokenReason: null });
  });

  it("keeps two consecutive quota 403s connected and honors Retry-After", async () => {
    const x = stateFixture();
    x.fake.forbidAccessToken("access-token", "userRateLimitExceeded", "17");

    expect(await failureValue(x.service.sync(base.id))).toEqual({ kind: "transient", retryAfterMs: 17_000 });
    expect(await failureValue(x.service.sync(base.id))).toEqual({ kind: "transient", retryAfterMs: 17_000 });

    expect(x.fake.listRequests).toHaveLength(2);
    expect(x.state).toEqual({ status: "connected", brokenReason: null, lastSyncErrorAt: now, retryAfterMs: 17_000 });
  });

  it("marks insufficientPermissions after refresh as scope_missing", async () => {
    const x = stateFixture();
    x.fake.forbidAccessToken("access-token", "insufficientPermissions");

    expect(await failureValue(x.service.sync(base.id))).toEqual({ kind: "forbidden" });

    expect(x.fake.listRequests).toHaveLength(2);
    expect(x.state).toEqual({ status: "broken", brokenReason: "scope_missing", lastSyncErrorAt: now });
  });

  it("marks domainPolicy after refresh as scope_missing", async () => {
    const x = stateFixture();
    x.fake.forbidAccessToken("access-token", "DoMaInPoLiCy");

    expect(await failureValue(x.service.sync(base.id))).toEqual({ kind: "forbidden" });

    expect(x.fake.listRequests).toHaveLength(2);
    expect(x.state.status).toBe("broken");
    expect(x.state.brokenReason).toBe("scope_missing");
  });

  it("treats a malformed 403 body as transient", async () => {
    const x = stateFixture();
    x.fake.failNextList({ status: 403, malformed: true });

    expect(await failureValue(x.service.sync(base.id))).toEqual({ kind: "transient" });

    expect(x.fake.listRequests).toHaveLength(1);
    expect(x.state).toEqual({ status: "connected", brokenReason: null, lastSyncErrorAt: now });
  });
});
