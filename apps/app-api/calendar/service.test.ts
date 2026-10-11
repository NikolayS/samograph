import { describe, expect, it, spyOn } from "bun:test";
import { CalendarService, type CalendarConnection, type CalendarConnectionStore } from "./service.ts";
import { InMemoryRateLimiter } from "../auth/rate-limit.ts";
import { decryptSecret } from "../../../packages/shared/crypto.ts";
import type { GoogleCalendarOAuthPort } from "./google-calendar-oauth.ts";
import { GoogleCalendarOAuth } from "./google-calendar-oauth.ts";
import { FakeGoogleIdp } from "../../../packages/test-fakes/google-oauth/index.ts";

const key = Buffer.alloc(32, 7);
class Store implements CalendarConnectionStore {
  row: CalendarConnection | null = null;
  async tenantExists() { return true; }
  async get() { return this.row; }
  async save(row: CalendarConnection) { this.row = row; }
  async delete() { this.row = null; }
}

function setup(opts: { exchangeOk?: boolean; revoke?: () => Promise<boolean> } = {}) {
  const store = new Store(); let exchanges = 0; let revoked: string[] = [];
  const provider: GoogleCalendarOAuthPort = {
    authorizeUrl: ({ state, codeChallenge }) => `https://google.test/auth?state=${state}&code_challenge=${codeChallenge}`,
    async exchangeCode() { exchanges++; return opts.exchangeOk === false ? { ok: false } : { ok: true, refreshToken: "refresh-secret", scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] }; },
    async revoke(token) { revoked.push(token); return opts.revoke ? opts.revoke() : true; },
  };
  let random = 0;
  const service = new CalendarService({ provider, store, rateLimiter: new InMemoryRateLimiter(), sessionSecret: "secret", clock: () => 10_000, randomValue: () => `random-${++random}`, activeKey: key, activeKeyVersion: 1, decryptionKeys: new Map([[1, key]]) });
  return { service, store, get exchanges() { return exchanges; }, revoked };
}

describe("CalendarService", () => {
  it("rejects and revokes a refresh token when Google omits the required Calendar scope", async () => {
    const idp = new FakeGoogleIdp({ tokenResponseScopes: ["https://www.googleapis.com/auth/userinfo.email"] });
    const provider = new GoogleCalendarOAuth({ clientId: idp.clientId, clientSecret: "secret", redirectUri: "http://localhost:3000/calendar/connect/callback", fetchImpl: idp.fetchImpl });
    const store = new Store();
    const service = new CalendarService({ provider, store, rateLimiter: new InMemoryRateLimiter(), sessionSecret: "secret", clock: () => 10_000, randomValue: (() => { let n = 0; return () => `random-${++n}`; })(), activeKey: key, activeKeyVersion: 1, decryptionKeys: new Map([[1, key]]) });
    const started = await service.start({ userId: "user", tenantId: "tenant", ip: "ip" });
    if (!started.ok) throw new Error("start failed");
    const grant = idp.authorize(started.authorizationUrl);
    if (!grant.refreshToken) throw new Error("fake did not issue refresh token");
    const cookie = started.setCookie.match(/^[^=]+=([^;]+)/)?.[1] ?? "";
    const result = await service.callback({ userId: "user", tenantId: "tenant", ip: "ip", stateCookie: cookie, params: new URLSearchParams({ code: grant.code, state: grant.state ?? "" }) });
    expect(result).toEqual({ ok: false, code: "SAMO-CALENDAR-004" });
    expect(store.row).toBeNull();
    expect(idp.revokedTokens).toEqual([grant.refreshToken]);
  });

  it("starts with state bound to the current user and tenant", async () => {
    const { service } = setup();
    const result = await service.start({ userId: "user", tenantId: "tenant", ip: "ip" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorizationUrl).toContain("state=random-1");
    expect(result.setCookie).toContain("__Host-samo_calendar_oauth=");
  });

  it("does not exchange missing or mismatched state and clears it at the HTTP seam", async () => {
    const ctx = setup();
    const result = await ctx.service.callback({ userId: "other", tenantId: "tenant", ip: "ip", stateCookie: "bad", params: new URLSearchParams("code=x&state=y") });
    expect(result).toEqual({ ok: false, code: "SAMO-CALENDAR-003" });
    expect(ctx.exchanges).toBe(0);
  });

  it("encrypts the refresh token with connection/user/tenant AAD and reconnect replaces it", async () => {
    const ctx = setup();
    const started = await ctx.service.start({ userId: "user", tenantId: "tenant", ip: "ip" });
    if (!started.ok) throw new Error("start failed");
    const cookie = started.setCookie.match(/^[^=]+=([^;]+)/)?.[1] ?? "";
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(await ctx.service.callback({ userId: "user", tenantId: "tenant", ip: "ip", stateCookie: cookie, params: new URLSearchParams({ code: "code", state }) })).toEqual({ ok: true });
    const row = ctx.store.row!;
    expect(decryptSecret({ ciphertext: row.encryptedRefreshToken, iv: row.refreshTokenIv, tag: row.refreshTokenTag, keyVersion: row.encryptionKeyVersion }, key, `samo.calendar.refresh.v1|${row.id}|user|tenant`)).toBe("refresh-secret");
    const id = row.id;
    const started2 = await ctx.service.start({ userId: "user", tenantId: "tenant", ip: "ip" });
    if (!started2.ok) throw new Error("start failed");
    const cookie2 = started2.setCookie.match(/^[^=]+=([^;]+)/)?.[1] ?? "";
    const state2 = new URL(started2.authorizationUrl).searchParams.get("state")!;
    await ctx.service.callback({ userId: "user", tenantId: "tenant", ip: "ip", stateCookie: cookie2, params: new URLSearchParams({ code: "code2", state: state2 }) });
    expect(ctx.store.row?.id).toBe(id);
  });

  async function expectCallbackPersistenceFailure(ctx: ReturnType<typeof setup>, thrown: unknown) {
    ctx.store.save = async () => { throw thrown; };
    const error = spyOn(console, "error").mockImplementation(() => {});
    const started = await ctx.service.start({ userId: "user", tenantId: "tenant", ip: "ip" });
    if (!started.ok) throw new Error("start failed");
    const cookie = started.setCookie.match(/^[^=]+=([^;]+)/)?.[1] ?? "";
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    const result = await ctx.service.callback({ userId: "user", tenantId: "tenant", ip: "ip", stateCookie: cookie, params: new URLSearchParams({ code: "code", state }) });
    return { error, result };
  }

  it("logs a valid SQLSTATE for callback persistence failures", async () => {
    const ctx = setup();
    const persistenceError = Object.assign(new Error("database save failed with encrypted credential material"), { code: "23505" });
    const { error, result } = await expectCallbackPersistenceFailure(ctx, persistenceError);
    try {
      expect(result).toEqual({ ok: false, code: "SAMO-CALENDAR-500" });
      expect(error).toHaveBeenCalledWith("SAMO-CALENDAR-500 calendar callback failed", { sqlstate: "23505" });
    } finally {
      error.mockRestore();
    }
  });

  it("does not log error messages, constructor names, or invalid SQLSTATE values", async () => {
    const ctx = setup();
    const persistenceError = { message: "SECRET message", constructor: { name: "SECRET constructor" }, code: "ab!de" };
    const { error, result } = await expectCallbackPersistenceFailure(ctx, persistenceError);
    try {
      expect(result).toEqual({ ok: false, code: "SAMO-CALENDAR-500" });
      expect(error).toHaveBeenCalledWith("SAMO-CALENDAR-500 calendar callback failed", { sqlstate: null });
      expect(JSON.stringify(error.mock.calls)).not.toContain("SECRET");
    } finally {
      error.mockRestore();
    }
  });

  it("contains throwing SQLSTATE getters and still maps the callback failure", async () => {
    const ctx = setup();
    const persistenceError = Object.defineProperty({}, "code", { get() { throw new Error("getter failed"); } });
    const { error, result } = await expectCallbackPersistenceFailure(ctx, persistenceError);
    try {
      expect(result).toEqual({ ok: false, code: "SAMO-CALENDAR-500" });
      expect(error).toHaveBeenCalledWith("SAMO-CALENDAR-500 calendar callback failed", { sqlstate: null });
    } finally {
      error.mockRestore();
    }
  });

  it("disconnect is idempotent and deletes locally despite revocation failure", async () => {
    const ctx = setup({ revoke: async () => false });
    const started = await ctx.service.start({ userId: "user", tenantId: "tenant", ip: "ip" });
    if (!started.ok) throw new Error();
    const cookie = started.setCookie.match(/^[^=]+=([^;]+)/)?.[1] ?? "";
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await ctx.service.callback({ userId: "user", tenantId: "tenant", ip: "ip", stateCookie: cookie, params: new URLSearchParams({ code: "x", state }) });
    await ctx.service.disconnect("user", "tenant");
    await ctx.service.disconnect("user", "tenant");
    expect(ctx.revoked).toEqual(["refresh-secret"]);
    expect(ctx.store.row).toBeNull();
  });
});
