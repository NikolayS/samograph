import { describe, expect, it } from "bun:test";
import { createCalendarHandler } from "./http.ts";
import { CalendarService, type CalendarConnection, type CalendarConnectionStore } from "./service.ts";
import { InMemoryRateLimiter } from "../auth/rate-limit.ts";
import { buildClearedSessionCookie, signSession } from "../auth/session.ts";
import { GoogleCalendarOAuth } from "./google-calendar-oauth.ts";
import { FakeGoogleIdp } from "../../../packages/test-fakes/google-oauth/index.ts";
import { buildClearedCalendarOAuthStateCookie } from "./oauth-state.ts";

const now = 50_000, secret = "session-secret";
class Store implements CalendarConnectionStore {
  row: CalendarConnection | null = null;
  active = true;
  async tenantExists() { return this.active; }
  async get() { return this.row; }
  async save(row: CalendarConnection) { this.row = row; }
  async delete() { this.row = null; }
  excludedMeetingIds: string[] = [];
  async excludeMeeting(_userId: string, _tenantId: string, eventId: string) { this.excludedMeetingIds.push(eventId); return true; }
}
function handler() {
  const store = new Store();
  const service = new CalendarService({ provider: undefined, store,
    rateLimiter: new InMemoryRateLimiter(), sessionSecret: secret, clock: () => now,
    activeKey: Buffer.alloc(32), activeKeyVersion: 1, decryptionKeys: new Map([[1, Buffer.alloc(32)]]) });
  return createCalendarHandler(service, secret, () => now);
}
const session = () => `samo_session=${signSession({ userId: "user", tenantId: "tenant", iat: now }, secret)}`;

describe("calendar HTTP adapter", () => {
  it("rejects a malformed meeting UUID before calling the service", async () => {
    const store = new Store();
    const service = new CalendarService({ provider: undefined, store,
      rateLimiter: new InMemoryRateLimiter(), sessionSecret: secret, clock: () => now,
      activeKey: Buffer.alloc(32), activeKeyVersion: 1, decryptionKeys: new Map([[1, Buffer.alloc(32)]]) });
    const response = await createCalendarHandler(service, secret, () => now)(new Request("http://api.test/calendar/meetings/not-a-uuid", {
      method: "PATCH", headers: { cookie: session(), "content-type": "application/json" }, body: JSON.stringify({ excluded: true }),
    }));

    expect(response.status).toBe(400);
    expect(store.excludedMeetingIds).toEqual([]);
  });

  it("uses the dead-session convention when owner resolution marks the tenant erased", async () => {
    const store = new Store();
    store.active = false;
    const service = new CalendarService({ provider: undefined, store,
      rateLimiter: new InMemoryRateLimiter(), sessionSecret: secret, clock: () => now,
      activeKey: Buffer.alloc(32), activeKeyVersion: 1, decryptionKeys: new Map([[1, Buffer.alloc(32)]]) });
    const h = createCalendarHandler(service, secret, () => now);
    for (const [method, path] of [["POST", "/calendar/connect/start"], ["GET", "/calendar/status"], ["DELETE", "/calendar/connection"]]) {
      const response = await h(new Request(`http://api.test${path}`, { method, headers: { cookie: session() } }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        code: "SAMO-AUTH-005",
        message: "You've been signed out. Please sign in again.",
        retryable: false,
      });
      expect(response.headers.get("set-cookie") ?? "").toContain("samo_session=;");
    }

    const callback = await h(new Request("http://api.test/calendar/connect/callback", {
      headers: { cookie: `${session()}; __Host-samo_calendar_oauth=live-state` },
    }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/auth");
    expect(callback.headers.getSetCookie()).toEqual([
      buildClearedSessionCookie(),
      buildClearedCalendarOAuthStateCookie(),
    ]);
  });

  it("redirects a scope-deficient Google grant to SAMO-CALENDAR-004 without persisting it", async () => {
    const idp = new FakeGoogleIdp({ tokenResponseScopes: ["https://www.googleapis.com/auth/userinfo.email"] });
    const store = new Store();
    const provider = new GoogleCalendarOAuth({ clientId: idp.clientId, clientSecret: "secret", redirectUri: "http://localhost:3000/calendar/connect/callback", fetchImpl: idp.fetchImpl });
    const service = new CalendarService({ provider, store, rateLimiter: new InMemoryRateLimiter(), sessionSecret: secret, clock: () => now, activeKey: Buffer.alloc(32), activeKeyVersion: 1, decryptionKeys: new Map([[1, Buffer.alloc(32)]]) });
    const h = createCalendarHandler(service, secret, () => now);
    const start = await h(new Request("http://api.test/calendar/connect/start", { method: "POST", headers: { cookie: session() } }));
    const grant = idp.authorize((await start.json() as { authorization_url: string }).authorization_url);
    if (!grant.refreshToken) throw new Error("fake did not issue refresh token");
    const stateCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const callback = await h(new Request(`http://api.test/calendar/connect/callback?code=${grant.code}&state=${grant.state}`, { headers: { cookie: `${session()}; ${stateCookie}` } }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings?calendar_error=SAMO-CALENDAR-004");
    expect(store.row).toBeNull();
    expect(idp.revokedTokens).toEqual([grant.refreshToken]);
  });

  it("rejects unauthenticated start/status/delete and callback clears state", async () => {
    const h = handler();
    for (const [method, path] of [["POST", "/calendar/connect/start"], ["GET", "/calendar/status"], ["DELETE", "/calendar/connection"]]) {
      expect((await h(new Request(`http://api.test${path}`, { method }))).status).toBe(401);
    }
    const callback = await h(new Request("http://api.test/calendar/connect/callback"));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings?calendar_error=SAMO-CALENDAR-003");
    expect(callback.headers.get("set-cookie")).toBe("__Host-samo_calendar_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  });

  it("returns exact not-connected status and idempotent 204", async () => {
    const h = handler();
    const status = await h(new Request("http://api.test/calendar/status", { headers: { cookie: session() } }));
    expect(await status.json()).toEqual({ provider: "google", state: "not_connected", connected_at: null, last_sync_at: null, last_sync_error_at: null });
    expect((await h(new Request("http://api.test/calendar/connection", { method: "DELETE", headers: { cookie: session() } }))).status).toBe(204);
  });

  it("returns SAMO-CALENDAR-001 JSON when start is unconfigured", async () => {
    const res = await handler()(new Request("http://api.test/calendar/connect/start", { method: "POST", headers: { cookie: session(), "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "SAMO-CALENDAR-001" });
  });
});
