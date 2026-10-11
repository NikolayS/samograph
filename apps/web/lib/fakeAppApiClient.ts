/**
 * In-memory fake `AppApiClient` for component/route tests. Records every request
 * so tests can assert the exact call shape, and returns deterministic responses
 * with no network. Configure `failVerifyWith` to exercise the typed
 * `SAMO-AUTH-00x` error paths on the callback page.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 */
import {
  AppApiError,
  type AppApiClient,
  type AuthProviders,
  type Call,
  type CalendarMeeting,
  type CalendarMeetingsSnapshot,
  type CalendarStatus,
  type CreateCallInput,
  type HostedSettings,
  type LinkedSignInMethod,
  type RequestMagicLinkInput,
  type SavedSettings,
  type SettingsOptions,
  type SettingsSnapshot,
} from "./appApiClient.ts";
import { validateMeetingUrl } from "./validateMeetingUrl.ts";

export interface RecordedRequest {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
}

/** The §5.12 defaults the fake serves before anything is saved. */
const DEFAULT_FAKE_SETTINGS: HostedSettings = {
  dictionaryPreset: "none",
  keyterms: [],
  language: "multi",
  chime: "blip",
};

/** The account address the fake reports on the Sign-in block (§5.12, S5-1 #8). */
const DEFAULT_FAKE_ACCOUNT_EMAIL = "owner@example.test";

/** A representative option catalog (mirrors the server's `settingsOptions`). */
const FAKE_SETTINGS_OPTIONS: SettingsOptions = {
  chimes: ["blip", "two-tone", "bell", "glass", "marimba"],
  languages: [
    { code: "multi", label: "Multilingual (auto-detect)" },
    { code: "en", label: "English" },
    { code: "es", label: "Spanish" },
    { code: "fr", label: "French" },
    { code: "de", label: "German" },
  ],
  presets: ["none", "postgresfm"],
};

export interface FailSpec {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface FakeAppApiClientOptions {
  /**
   * When set, `verifyMagicLink` rejects with this typed error. Include `status`
   * to simulate an infra/5xx response (whose body may lack a `code`).
   */
  failVerifyWith?: FailSpec & { status?: number };
  /**
   * When set, `verifyMagicLink` rejects with this raw (non-typed) error AFTER
   * recording the request — simulates a network failure (fetch throws before
   * any HTTP status is known).
   */
  failVerifyWithRaw?: Error;
  /**
   * When true, `verifyMagicLink` records its request but never settles, so a
   * test can deterministically observe the "verifying" state with no race.
   */
  holdVerify?: boolean;
  /**
   * What `GET /auth/providers` reports for Google (#209). Defaults to `false` —
   * the same answer a branch preview, an unconfigured env, and a FAILED probe all
   * give, so a test must opt IN to the button existing.
   */
  googleEnabled?: boolean;
  googleCalendarEnabled?: boolean;
  seedCalendarStatus?: CalendarStatus;
  seedCalendarMeetings?: CalendarMeetingsSnapshot;
  calendarAuthorizationUrl?: string;
  failGetCalendarStatusWith?: FailSpec & { status?: number };
  failStartCalendarConnectWith?: FailSpec & { status?: number };
  failDisconnectCalendarWith?: FailSpec & { status?: number };
  failUpdateCalendarAutoJoinWith?: FailSpec & { status?: number };
  failSetCalendarMeetingExcludedWith?: FailSpec & { status?: number };
  failListCalendarMeetingsWith?: FailSpec & { status?: number };
  /** Seed `listCalls` with pre-existing tenant calls (e.g. to test reload). */
  seedCalls?: Call[];
  /** DEV-link returned by `lastDevMagicLink` (simulates the `__dev` endpoint). */
  devMagicLink?: string;
  /**
   * When set, `createCall` rejects with this typed error AFTER recording the
   * request — simulates a server-side rejection (e.g. SAMO-CALL-URL) for a URL
   * that passes the client's looser pre-flight check.
   */
  failCreateCallWith?: FailSpec & { status?: number };
  /**
   * When set, the next `listCalls` rejects with this typed error (e.g. a 401 to
   * exercise the dashboard's auth-gate redirect).
   */
  failListCallsWith?: FailSpec & { status?: number };
  /**
   * When set, `getCall` rejects with this typed error AFTER recording the
   * request — simulates an owner read failure such as an RLS-hidden 404.
   */
  failGetCallWith?: FailSpec & { status?: number };
  /**
   * When set, `logout` rejects with this typed error AFTER recording the request
   * — lets a test assert the button STILL redirects on a best-effort failure.
   */
  failLogoutWith?: FailSpec & { status?: number };
  /**
   * When set, `deleteCall` rejects with this typed error AFTER recording the
   * request — simulates a server-side rejection (e.g. a 404/403) so a test can
   * assert the per-call delete's error path.
   */
  failDeleteCallWith?: FailSpec & { status?: number };
  /**
   * When set, `deleteAccount` rejects with this typed error AFTER recording the
   * request — simulates a server-side rejection (e.g. a 403/401) so a test can
   * assert the danger-zone error path (no redirect, error surfaced).
   */
  failDeleteAccountWith?: FailSpec & { status?: number };
  /** Seed the tenant's hosted settings (§5.12); defaults to {@link DEFAULT_FAKE_SETTINGS}. */
  seedSettings?: HostedSettings;
  /**
   * Seed the account's linked external identities for the §5.12 Sign-in block
   * (S5-1 item 8). Defaults to `[]` — a magic-link-only account, which is what
   * every user is until they use Google, so a test must opt IN to a linked row.
   */
  seedIdentities?: LinkedSignInMethod[];
  /** The account's authoritative `users.email` shown beside the magic-link row. */
  seedAccountEmail?: string;
  /**
   * When set, `getSettings` rejects with this typed error AFTER recording the
   * request — e.g. a 401 to exercise the settings page's auth-gate redirect.
   */
  failGetSettingsWith?: FailSpec & { status?: number };
  /**
   * When set, `saveSettings` rejects with this typed error AFTER recording the
   * request — e.g. a 400 (SAMO-SETTINGS-INVALID) or a 401.
   */
  failSaveSettingsWith?: FailSpec & { status?: number };
}

export class FakeAppApiClient implements AppApiClient {
  readonly requests: RecordedRequest[] = [];
  private callCounter = 0;
  private readonly calls: Call[] = [];
  private readonly options: FakeAppApiClientOptions;
  private settings: HostedSettings;
  private calendarStatus: CalendarStatus;
  private calendarMeetings: CalendarMeeting[];

  constructor(options: FakeAppApiClientOptions = {}) {
    this.options = options;
    if (options.seedCalls) this.calls.push(...options.seedCalls);
    this.settings = { ...(options.seedSettings ?? DEFAULT_FAKE_SETTINGS) };
    this.calendarStatus = options.seedCalendarStatus ?? { provider: "google", state: "not_connected", connectedAt: null, lastSyncAt: null, lastSyncErrorAt: null };
    this.calendarMeetings = (options.seedCalendarMeetings?.meetings ?? []).map((m) => ({ ...m }));
  }

  async requestMagicLink(input: RequestMagicLinkInput): Promise<void> {
    this.requests.push({
      path: "/auth/magic-link",
      method: "POST",
      body: { email: input.email },
    });
  }

  async authProviders(): Promise<AuthProviders> {
    this.requests.push({ path: "/auth/providers", method: "GET", body: {} });
    // Mirrors the real client's contract exactly: this never rejects, so the
    // fake grows no `failAuthProvidersWith` — a "failed probe" IS `{google:false}`.
    return { google: this.options.googleEnabled === true, ...(this.options.googleCalendarEnabled === true ? { googleCalendar: true } : {}) };
  }

  async getCalendarStatus(): Promise<CalendarStatus> {
    this.requests.push({ path: "/calendar/status", method: "GET", body: {} });
    this.fail(this.options.failGetCalendarStatusWith);
    return { ...this.calendarStatus };
  }

  async startCalendarConnect(): Promise<{ authorizationUrl: string }> {
    this.requests.push({ path: "/calendar/connect/start", method: "POST", body: {} });
    this.fail(this.options.failStartCalendarConnectWith);
    return { authorizationUrl: this.options.calendarAuthorizationUrl ?? "https://accounts.google.test/calendar" };
  }

  async disconnectCalendar(): Promise<void> {
    this.requests.push({ path: "/calendar/connection", method: "DELETE", body: {} });
    this.fail(this.options.failDisconnectCalendarWith);
    this.calendarStatus = { provider: "google", state: "not_connected", connectedAt: null, lastSyncAt: null, lastSyncErrorAt: null };
    this.calendarMeetings = [];
  }

  async updateCalendarAutoJoin(autoJoin: boolean): Promise<CalendarStatus> {
    this.requests.push({ path: "/calendar/connection", method: "PATCH", body: { auto_join: autoJoin } });
    this.fail(this.options.failUpdateCalendarAutoJoinWith);
    this.calendarStatus = { ...this.calendarStatus, autoJoin };
    return { ...this.calendarStatus };
  }

  async setCalendarMeetingExcluded(eventId: string, excluded: boolean): Promise<{ id: string; excluded: boolean }> {
    this.requests.push({ path: `/calendar/meetings/${encodeURIComponent(eventId)}`, method: "PATCH", body: { excluded } });
    this.fail(this.options.failSetCalendarMeetingExcludedWith);
    const meeting = this.calendarMeetings.find((row) => row.id === eventId);
    if (meeting) meeting.autoJoinExcluded = excluded;
    return { id: eventId, excluded };
  }

  async listCalendarMeetings(limit?: number): Promise<CalendarMeetingsSnapshot> {
    this.requests.push({ path: limit === undefined ? "/calendar/meetings" : `/calendar/meetings?limit=${limit}`, method: "GET", body: {} });
    this.fail(this.options.failListCalendarMeetingsWith);
    const seeded = this.options.seedCalendarMeetings;
    return { connectionState: seeded?.connectionState ?? this.calendarStatus.state, meetings: limit === undefined ? this.calendarMeetings.map((m) => ({ ...m })) : this.calendarMeetings.slice(0, limit).map((m) => ({ ...m })), lastSyncAt: seeded?.lastSyncAt ?? this.calendarStatus.lastSyncAt, autoJoin: seeded?.autoJoin ?? this.calendarStatus.autoJoin, ...(seeded?.errorCode ? { errorCode: seeded.errorCode } : {}) };
  }

  private fail(spec?: FailSpec & { status?: number }): void {
    if (spec) throw new AppApiError(spec.code, spec.message, spec.retryable ?? false, spec.status);
  }

  async verifyMagicLink(token: string): Promise<void> {
    this.requests.push({
      path: "/auth/callback",
      method: "GET",
      body: { token },
    });
    if (this.options.holdVerify) {
      // Never settle: lets a test observe the "verifying" state with no race.
      return new Promise<void>(() => {});
    }
    if (this.options.failVerifyWithRaw) {
      throw this.options.failVerifyWithRaw;
    }
    const fail = this.options.failVerifyWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
  }

  async logout(): Promise<void> {
    this.requests.push({ path: "/auth/logout", method: "POST", body: {} });
    const fail = this.options.failLogoutWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
  }

  async createCall(input: CreateCallInput): Promise<Call> {
    // Record the SERVER's body contract (snake_case `meeting_url`, SPEC §5.2) —
    // the same key the real `createHttpAppApiClient` serializes — so component
    // tests assert against the wire shape, not a client-only camelCase shape.
    this.requests.push({
      path: "/calls",
      method: "POST",
      body: { meeting_url: input.meetingUrl },
    });
    const fail = this.options.failCreateCallWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    const validation = validateMeetingUrl(input.meetingUrl);
    if (!validation.ok) {
      // Mirror app-api's typed rejection verbatim (code + copy, calls/errors.ts).
      throw new AppApiError(
        "SAMO-CALL-URL",
        "That doesn't look like a Zoom or Google Meet meeting link.",
        false,
        400,
      );
    }
    this.callCounter += 1;
    const call: Call = {
      id: `call_${this.callCounter}`,
      meetingUrl: validation.url,
      provider: validation.provider,
      status: "PENDING",
      // The server stamps `created_at` on insert; the fake mirrors it so a
      // freshly-created row renders its relative time like a real one.
      createdAt: new Date().toISOString(),
    };
    this.calls.unshift(call);
    return call;
  }

  async deleteCall(callId: string): Promise<void> {
    this.requests.push({
      path: `/calls/${callId}`,
      method: "DELETE",
      body: {},
    });
    const fail = this.options.failDeleteCallWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    // Success: drop the call from the in-memory list so a subsequent listCalls
    // reflects the erasure (§5.14), mirroring the server's row delete.
    const idx = this.calls.findIndex((c) => c.id === callId);
    if (idx !== -1) this.calls.splice(idx, 1);
  }

  async getCall(callId: string): Promise<Call> {
    this.requests.push({ path: `/calls/${callId}`, method: "GET", body: {} });
    this.fail(this.options.failGetCallWith);
    const call = this.calls.find((c) => c.id === callId);
    if (call) return { ...call };
    // Owner reads deliberately hide unknown and cross-tenant calls behind the
    // same bodyless 404, matching app-api's RLS-backed no-existence-leak path.
    throw new AppApiError("SAMO-AUTHZ-001", "Request failed.", false, 404);
  }

  async deleteAccount(): Promise<void> {
    this.requests.push({ path: "/account", method: "DELETE", body: {} });
    const fail = this.options.failDeleteAccountWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    // Success: the whole account is gone — drop the in-memory call list too.
    this.calls.length = 0;
  }

  async listCalls(): Promise<Call[]> {
    this.requests.push({ path: "/calls", method: "GET", body: {} });
    const fail = this.options.failListCallsWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    return this.calls.map((c) => ({ ...c }));
  }

  async getSettings(): Promise<SettingsSnapshot> {
    this.requests.push({ path: "/settings", method: "GET", body: {} });
    const fail = this.options.failGetSettingsWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    return {
      settings: { ...this.settings },
      options: FAKE_SETTINGS_OPTIONS,
      // Mirrors the server exactly: ALWAYS an array, never absent (#223).
      signin: {
        email: this.options.seedAccountEmail ?? DEFAULT_FAKE_ACCOUNT_EMAIL,
        identities: (this.options.seedIdentities ?? []).map((i) => ({ ...i })),
      },
    };
  }

  async saveSettings(input: HostedSettings): Promise<SavedSettings> {
    // Record the SERVER's snake_case wire body so tests assert the exact contract.
    this.requests.push({
      path: "/settings",
      method: "PUT",
      body: {
        dictionary_preset: input.dictionaryPreset,
        keyterms: input.keyterms,
        language: input.language,
        chime: input.chime,
      },
    });
    const fail = this.options.failSaveSettingsWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    this.settings = { ...input };
    return { settings: { ...this.settings }, options: FAKE_SETTINGS_OPTIONS };
  }

  async lastDevMagicLink(email: string): Promise<string | null> {
    this.requests.push({
      path: "/__dev/last-magic-link",
      method: "GET",
      body: { email },
    });
    return this.options.devMagicLink ?? null;
  }
}

export function createFakeAppApiClient(
  options?: FakeAppApiClientOptions,
): FakeAppApiClient {
  return new FakeAppApiClient(options);
}
