import { randomUUID } from "node:crypto";
import type { RateLimiter } from "../auth/rate-limit.ts";
import { RATE_WINDOW_MS } from "../auth/service.ts";
import { randomToken } from "../auth/crypto.ts";
import { codeChallengeS256 } from "../auth/oauth-state.ts";
import { decryptSecret, encryptSecret } from "../../../packages/shared/crypto.ts";
import { GOOGLE_CALENDAR_SCOPE, type GoogleCalendarOAuthPort } from "./google-calendar-oauth.ts";
import { issueCalendarOAuthStateCookie, verifyCalendarOAuthStateForCallback } from "./oauth-state.ts";

export type CalendarErrorCode = "SAMO-CALENDAR-001" | "SAMO-CALENDAR-002" | "SAMO-CALENDAR-003" | "SAMO-CALENDAR-004" | "SAMO-CALENDAR-005" | "SAMO-CALENDAR-006" | "SAMO-CALENDAR-500";
export interface CalendarConnection {
  id: string; userId: string; tenantId: string;
  encryptedRefreshToken: Buffer; refreshTokenIv: Buffer; refreshTokenTag: Buffer;
  encryptionKeyVersion: number; grantedScopes: string[]; status: "connected" | "broken";
  autoJoin: boolean;
  connectedAt: Date; lastSyncAt: Date | null; lastSyncErrorAt: Date | null;
}
export interface CalendarConnectionStore {
  tenantExists(tenantId: string): Promise<boolean>;
  get(userId: string, tenantId: string): Promise<CalendarConnection | null>;
  save(row: CalendarConnection): Promise<void>;
  delete(userId: string, tenantId: string): Promise<void>;
  updateAutoJoin?(userId: string, tenantId: string, autoJoin: boolean): Promise<CalendarConnection | null>;
  excludeMeeting?(userId: string, tenantId: string, eventId: string, excluded: boolean): Promise<boolean>;
  meetings?(userId: string, tenantId: string, limit: number, now: Date): Promise<CalendarMeetingsSnapshot>;
}
export interface CalendarMeeting { id: string; title: string; startsAt: Date; endsAt: Date; allDay: boolean; meetingUrl: string | null; meetingProvider: "google_meet" | "zoom" | null; organizerEmail: string | null; attendeeResponse: "needsAction" | "declined" | "tentative" | "accepted" | null; autoJoinExcluded?: boolean; }
export interface CalendarMeetingsSnapshot { connection: (Pick<CalendarConnection, "status" | "lastSyncAt"> & Partial<Pick<CalendarConnection, "autoJoin">>) | null; meetings: CalendarMeeting[]; }
export interface CalendarServiceDeps {
  provider?: GoogleCalendarOAuthPort; store: CalendarConnectionStore; rateLimiter: RateLimiter;
  sessionSecret: string; clock: () => number; randomValue?: () => string;
  activeKey: Buffer; activeKeyVersion: number; decryptionKeys: Map<number, Buffer>;
  immediateSync?: (connectionId: string) => Promise<unknown>;
}
const START_LIMIT = 20, CALLBACK_LIMIT = 20;
const aad = (row: Pick<CalendarConnection, "id" | "userId" | "tenantId">) => `samo.calendar.refresh.v1|${row.id}|${row.userId}|${row.tenantId}`;

export class CalendarService {
  readonly #deps: CalendarServiceDeps; readonly #random: () => string;
  constructor(deps: CalendarServiceDeps) { this.#deps = deps; this.#random = deps.randomValue ?? randomToken; }
  get configured() { return this.#deps.provider !== undefined; }
  async tenantExists(tenantId: string) { return this.#deps.store.tenantExists(tenantId); }
  async start(input: { userId: string; tenantId: string; ip: string }) {
    if (!this.#deps.provider) return { ok: false as const, code: "SAMO-CALENDAR-001" as const };
    const decision = await this.#deps.rateLimiter.hit(`calendar-start:ip:${input.ip}`, START_LIMIT, RATE_WINDOW_MS, this.#deps.clock());
    if (!decision.allowed) return { ok: false as const, code: "SAMO-CALENDAR-500" as const };
    const state = this.#random(), codeVerifier = this.#random();
    return { ok: true as const,
      authorizationUrl: this.#deps.provider.authorizeUrl({ state, codeChallenge: codeChallengeS256(codeVerifier) }),
      setCookie: issueCalendarOAuthStateCookie({ state, codeVerifier, userId: input.userId, tenantId: input.tenantId }, this.#deps.sessionSecret, this.#deps.clock),
    };
  }
  async callback(input: { userId: string; tenantId: string; ip: string; stateCookie: string | null; params: URLSearchParams }) {
    if (!this.#deps.provider) return { ok: false as const, code: "SAMO-CALENDAR-001" as const };
    if (input.params.has("error")) return { ok: false as const, code: input.params.get("error") === "access_denied" ? "SAMO-CALENDAR-002" as const : "SAMO-CALENDAR-004" as const };
    if (!input.stateCookie) return { ok: false as const, code: "SAMO-CALENDAR-003" as const };
    const claims = verifyCalendarOAuthStateForCallback(input.stateCookie, this.#deps.sessionSecret, input.params.get("state"), input.userId, input.tenantId, this.#deps.clock());
    if (!claims) return { ok: false as const, code: "SAMO-CALENDAR-003" as const };
    const code = input.params.get("code");
    if (!code) return { ok: false as const, code: "SAMO-CALENDAR-004" as const };
    const decision = await this.#deps.rateLimiter.hit(`calendar-callback:ip:${input.ip}`, CALLBACK_LIMIT, RATE_WINDOW_MS, this.#deps.clock());
    if (!decision.allowed) return { ok: false as const, code: "SAMO-CALENDAR-500" as const };
    const exchanged = await this.#deps.provider.exchangeCode({ code, codeVerifier: claims.codeVerifier });
    if (!exchanged.ok) return { ok: false as const, code: "SAMO-CALENDAR-004" as const };
    if (!exchanged.scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
      await this.#deps.provider.revoke(exchanged.refreshToken).catch(() => false);
      return { ok: false as const, code: "SAMO-CALENDAR-004" as const };
    }
    try {
      const existing = await this.#deps.store.get(input.userId, input.tenantId);
      const rowBase = { id: existing?.id ?? randomUUID(), userId: input.userId, tenantId: input.tenantId };
      const encrypted = encryptSecret(exchanged.refreshToken, this.#deps.activeKey, this.#deps.activeKeyVersion, aad(rowBase));
      const row: CalendarConnection = { ...rowBase, encryptedRefreshToken: encrypted.ciphertext, refreshTokenIv: encrypted.iv, refreshTokenTag: encrypted.tag, encryptionKeyVersion: encrypted.keyVersion, grantedScopes: exchanged.scopes, status: "connected", autoJoin: existing?.autoJoin ?? false, connectedAt: new Date(this.#deps.clock()), lastSyncAt: null, lastSyncErrorAt: null };
      await this.#deps.store.save(row);
      // Slice 2 seam: Slices 3/4 inject the shared immediate synchronization service.
      await this.#deps.immediateSync?.(row.id).catch(() => {});
      return { ok: true as const };
    } catch (error) {
      let sqlstate: string | null = null;
      try {
        if (error && typeof error === "object") {
          for (const key of ["code", "errno"]) {
            const candidate = Reflect.get(error, key);
            if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) {
              sqlstate = candidate;
              break;
            }
          }
        }
      } catch {}
      console.error('SAMO-CALENDAR-500 calendar callback failed', { sqlstate });
      return { ok: false as const, code: "SAMO-CALENDAR-500" as const };
    }
  }
  async status(userId: string, tenantId: string) { return this.#deps.store.get(userId, tenantId); }
  async meetings(userId: string, tenantId: string, limit: number) { return this.#deps.store.meetings?.(userId, tenantId, limit, new Date(this.#deps.clock())) ?? { connection: null, meetings: [] }; }
  async updateAutoJoin(userId: string, tenantId: string, autoJoin: boolean) { return this.#deps.store.updateAutoJoin?.(userId, tenantId, autoJoin) ?? null; }
  async excludeMeeting(userId: string, tenantId: string, eventId: string, excluded: boolean) { return this.#deps.store.excludeMeeting?.(userId, tenantId, eventId, excluded) ?? false; }
  async disconnect(userId: string, tenantId: string): Promise<"ok" | "failed" | "not_configured" | "not_connected"> {
    const row = await this.#deps.store.get(userId, tenantId);
    if (!row) return "not_connected";
    let revocationResult = "not_configured";
    try {
      const key = this.#deps.decryptionKeys.get(row.encryptionKeyVersion);
      if (key && this.#deps.provider) revocationResult = await this.#deps.provider.revoke(decryptSecret({ ciphertext: row.encryptedRefreshToken, iv: row.refreshTokenIv, tag: row.refreshTokenTag, keyVersion: row.encryptionKeyVersion }, key, aad(row))) ? "ok" : "failed";
    } catch { revocationResult = "failed"; }
    await this.#deps.store.delete(userId, tenantId);
    return revocationResult as "ok" | "failed" | "not_configured";
  }
}
