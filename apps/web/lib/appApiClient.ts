/**
 * Typed app-api client seam.
 *
 * The frontend talks to app-api (magic-link auth + `/calls`) only through this
 * interface. Components receive an `AppApiClient` by injection, so they are
 * testable against an in-memory fake (see `fakeAppApiClient.ts`) with no server
 * — which makes this issue independent of the backend merge order (#42/#43).
 *
 * Real network failures are surfaced as typed `AppApiError`s carrying the stable
 * `SAMO-…` code from SPEC §5.16, never as silent hangs.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 */
import {
  meetingProviderForUrl,
  type MeetingProvider,
} from "./validateMeetingUrl.ts";
import { throwTyped } from "./apiError.ts";

/** Call lifecycle status enum (SPEC §5.2). A fresh call starts at `PENDING`. */
export type CallStatus =
  | "PENDING"
  | "JOINING"
  | "IN_CALL"
  | "ENDED"
  | "COULD_NOT_JOIN"
  | "COULD_NOT_RECORD"
  | "BOT_REMOVED";

export interface Call {
  id: string;
  meetingUrl: string;
  provider: MeetingProvider;
  status: CallStatus;
  /**
   * §5.16 error detail for a terminal failure (`COULD_NOT_JOIN` /
   * `COULD_NOT_RECORD`), from the server's `status_reason`. Absent for healthy
   * calls and when the server recorded no specific reason.
   */
  statusReason?: string;
  /**
   * ISO-8601 creation timestamp from the server's `created_at`. Optional: a
   * `Call` synthesised locally (or an older server) may not carry one, and the
   * dashboard simply omits the row's relative time when it is absent.
   */
  createdAt?: string;
}

/**
 * Per-tenant hosted settings (SPEC §5.12): dictionary preset + custom keyterms,
 * transcription language, and the chat-chime id. camelCase in the web domain;
 * the wire body is snake_case (`dictionary_preset`), mapped at the client edge.
 */
export interface HostedSettings {
  dictionaryPreset: string;
  keyterms: string[];
  language: string;
  chime: string;
}

/** The choice catalog the settings UI renders its selects from (server-provided). */
export interface SettingsOptions {
  chimes: string[];
  languages: { code: string; label: string }[];
  presets: string[];
}

/**
 * One external sign-in method linked to the account (S5-1 item 8, §5.12).
 *
 * PRESENCE AND CONNECTION METADATA ONLY. The provider's `sub` and the
 * provider-asserted email are never sent by the server and must never be added
 * here: this block is rendered on a page people screenshot, and the `sub` is the
 * identity key. `magic_link` is deliberately NOT a member of this list — it is
 * the credential every environment has, so the UI lists it unconditionally
 * rather than inferring it from data.
 */
export interface LinkedSignInMethod {
  /** Mirrors migration 0011's CHECK domain — today always `"google"`. */
  provider: string;
  /** ISO-8601 instant the link was made, or `null` when the server sent none. */
  connectedAt: string | null;
}

/** The read-only "Sign-in" facts behind the Settings block (S5-1 item 8). */
export interface SignInInfo {
  /** `users.email` — authoritative and immutable; the address magic links go to. */
  email: string;
  /** Linked external identities, oldest first. `[]` for a magic-link-only account. */
  identities: LinkedSignInMethod[];
}

/** The `PUT /settings` response envelope: the stored document + the catalog. */
export interface SavedSettings {
  settings: HostedSettings;
  options: SettingsOptions;
}

/**
 * The `GET /settings` response envelope. It carries `signin` and the PUT
 * envelope does not — the two are separate types precisely so a caller cannot
 * read an empty `signin` off a save response and believe the account just lost
 * its linked methods.
 */
export interface SettingsSnapshot extends SavedSettings {
  signin: SignInInfo;
}

export interface RequestMagicLinkInput {
  email: string;
}

export interface CreateCallInput {
  meetingUrl: string;
}

/**
 * Which non-magic-link credentials this deployment offers (SPEC §5.16 / S5-1).
 * Google is absent on branch previews by design — Google exact-matches redirect
 * URIs and preview hostnames are dynamic — so `false` is a normal answer, not an
 * error.
 */
export interface AuthProviders {
  google: boolean;
  googleCalendar?: boolean;
}

export type CalendarConnectionState = "not_connected" | "connected" | "broken";
export interface CalendarStatus {
  provider: "google";
  state: CalendarConnectionState;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncErrorAt: string | null;
  errorCode?: "SAMO-CALENDAR-005";
  autoJoin?: boolean;
}
export interface CalendarMeeting {
  id: string; title: string; startsAt: string; endsAt: string; allDay: boolean;
  meetingUrl: string | null; meetingProvider: MeetingProvider | null;
  organizerEmail: string | null;
  attendeeResponse: "needsAction" | "declined" | "tentative" | "accepted" | null;
  autoJoinExcluded?: boolean;
}
export interface CalendarMeetingsSnapshot {
  connectionState: CalendarConnectionState;
  meetings: CalendarMeeting[];
  lastSyncAt: string | null;
  errorCode?: "SAMO-CALENDAR-005";
  autoJoin?: boolean;
}

export interface AppApiClient {
  /** `POST /auth/magic-link {email}` — server emails a one-time sign-in link. */
  requestMagicLink(input: RequestMagicLinkInput): Promise<void>;
  /**
   * `GET /auth/providers` — the SOLE gate on rendering "Continue with Google".
   *
   * NEVER rejects. Any failure (5xx, 404, network error, malformed JSON, a
   * missing or non-boolean field) resolves to `{google:false}`, because this
   * probe must not be able to break the sign-in page: magic link has to keep
   * working when the probe is broken, and a button that cannot possibly work is
   * worse than no button.
   */
  authProviders(): Promise<AuthProviders>;
  getCalendarStatus(): Promise<CalendarStatus>;
  startCalendarConnect(): Promise<{ authorizationUrl: string }>;
  disconnectCalendar(): Promise<void>;
  updateCalendarAutoJoin(autoJoin: boolean): Promise<CalendarStatus>;
  setCalendarMeetingExcluded(eventId: string, excluded: boolean): Promise<{ id: string; excluded: boolean }>;
  listCalendarMeetings(limit?: number): Promise<CalendarMeetingsSnapshot>;
  /** `GET /auth/callback?token=…` — verifies the link; throws `AppApiError` on failure. */
  verifyMagicLink(token: string): Promise<void>;
  /** `POST /auth/logout` — clears the session cookie server-side; throws `AppApiError` on failure. */
  logout(): Promise<void>;
  /** `POST /calls {meeting_url}` — creates a Call (returned at status `PENDING`). */
  createCall(input: CreateCallInput): Promise<Call>;
  /** `GET /calls` — the caller's tenant's calls (newest first); throws on 401. */
  listCalls(): Promise<Call[]>;
  /**
   * `GET /calls/:id` — read ONE call (owner view, §5.6). This is how the
   * per-call page learns the meeting URL: the old query-string carrier dropped
   * Zoom passcodes and exposed join data to address-bar history (#286).
   * Throws `AppApiError`.
   */
  getCall(callId: string): Promise<Call>;
  /**
   * `GET /settings` — the caller's hosted settings, the option catalog, and the
   * read-only `signin` block (§5.12, S5-1 item 8); throws on 401.
   */
  getSettings(): Promise<SettingsSnapshot>;
  /** `PUT /settings` — replace the caller's hosted settings (§5.12); returns the stored doc. */
  saveSettings(input: HostedSettings): Promise<SavedSettings>;
  /**
   * `DELETE /calls/:id` — permanently erase ONE call and all of its data
   * (transcript, share links, recording) — SPEC §5.14 GDPR per-call erasure.
   * Owner-only; throws `AppApiError` on failure.
   */
  deleteCall(callId: string): Promise<void>;
  /**
   * `DELETE /account` — permanently erase the WHOLE account: every call and its
   * data, all share links, and the Recall recordings; revokes all sessions and
   * emails a confirmation (SPEC §5.14 GDPR account erasure). Owner-only; the
   * server clears the session cookie. Throws `AppApiError` on failure.
   */
  deleteAccount(): Promise<void>;
  /**
   * DEV-ONLY: the most recent magic link for `email` from app-api's
   * `GET /__dev/last-magic-link`, or `null` (production, no link yet, any error).
   * Lets local testing proceed without a real inbox; a no-op in production.
   */
  lastDevMagicLink(email: string): Promise<string | null>;
}

export { AppApiError } from "./apiError.ts";

/**
 * Real HTTP client used by the Next.js pages. The backend (#42/#43) is not built
 * yet, so this is the seam that will light up once it exists; the page-level
 * wiring is intentionally thin and is exercised only through the fake in tests.
 */
export function createHttpAppApiClient(baseUrl = ""): AppApiClient {
  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  }

  /** camelCase settings → the snake_case PUT body the server reads (§5.12). */
  function settingsToWire(s: HostedSettings): Record<string, unknown> {
    return {
      dictionary_preset: s.dictionaryPreset,
      keyterms: s.keyterms,
      language: s.language,
      chime: s.chime,
    };
  }

  /**
   * The server's `signin` block (snake_case) → {@link SignInInfo}.
   *
   * TOTAL and never-throwing: a missing block, a non-array `identities`, or an
   * entry without a `provider` string all degrade to an EXPLICITLY empty shape.
   * The settings page must still render when the block is absent (an older
   * app-api behind a newer web build), and "no linked methods" is a safe thing to
   * show while "undefined" would blank the page.
   */
  function toSignIn(raw: unknown): SignInInfo {
    const block = (raw ?? {}) as { email?: unknown; identities?: unknown };
    const rows = Array.isArray(block.identities) ? block.identities : [];
    return {
      email: typeof block.email === "string" ? block.email : "",
      identities: rows
        .filter(
          (r): r is { provider: string; connected_at?: unknown } =>
            typeof (r as { provider?: unknown })?.provider === "string",
        )
        .map((r) => ({
          provider: r.provider,
          connectedAt: typeof r.connected_at === "string" ? r.connected_at : null,
        })),
    };
  }

  /** A server `/settings` response (snake_case) → the web `SavedSettings`. */
  function toSettingsSnapshot(data: {
    settings?: {
      dictionary_preset?: unknown;
      keyterms?: unknown;
      language?: unknown;
      chime?: unknown;
    };
    options?: {
      chimes?: unknown;
      languages?: unknown;
      presets?: unknown;
    };
  }): SavedSettings {
    const s = data.settings ?? {};
    const o = data.options ?? {};
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const languages = Array.isArray(o.languages)
      ? o.languages
          .filter(
            (l): l is { code: string; label: string } =>
              typeof (l as { code?: unknown })?.code === "string" &&
              typeof (l as { label?: unknown })?.label === "string",
          )
          .map((l) => ({ code: l.code, label: l.label }))
      : [];
    return {
      settings: {
        dictionaryPreset: typeof s.dictionary_preset === "string" ? s.dictionary_preset : "none",
        keyterms: strings(s.keyterms),
        language: typeof s.language === "string" ? s.language : "multi",
        chime: typeof s.chime === "string" ? s.chime : "blip",
      },
      options: {
        chimes: strings(o.chimes),
        languages,
        presets: strings(o.presets),
      },
    };
  }

  /** Map a server `calls` row (snake_case, no provider) to the web `Call` shape. */
  function toCall(
    id: string,
    meetingUrl: string,
    status: CallStatus,
    statusReason?: string,
    createdAt?: string,
  ): Call {
    return {
      id,
      meetingUrl,
      provider: meetingProviderForUrl(meetingUrl) ?? "google_meet",
      status,
      ...(statusReason !== undefined ? { statusReason } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }

  return {
    async requestMagicLink(input) {
      const res = await post("/auth/magic-link", { email: input.email });
      if (!res.ok) await throwTyped(res, "SAMO-AUTH-004");
    },
    async authProviders() {
      // Fail-closed and NEVER throw: one `try` around fetch AND `res.json()`, so
      // a network error and a malformed body land on the same `{google:false}`.
      try {
        const res = await fetch(`${baseUrl}/auth/providers`, {
          credentials: "same-origin",
        });
        if (!res.ok) return { google: false };
        const data = (await res.json()) as { google?: unknown; google_calendar?: unknown } | null;
        // Boolean-STRICT, mirroring the server's `email_verified` rule on this
        // same feature: the string "true" and the number 1 are not `true`.
        return { google: data?.google === true, ...(data?.google_calendar === true ? { googleCalendar: true } : {}) };
      } catch {
        return { google: false };
      }
    },
    async getCalendarStatus() {
      const res = await fetch(`${baseUrl}/calendar/status`, { credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-CALENDAR-500");
      const d = (await res.json()) as Record<string, unknown>;
      const state: CalendarConnectionState = d.state === "connected" || d.state === "broken" ? d.state : "not_connected";
      const error = typeof d.error === "object" && d.error !== null ? d.error as Record<string, unknown> : null;
      return {
        provider: "google", state,
        connectedAt: typeof d.connected_at === "string" ? d.connected_at : null,
        lastSyncAt: typeof d.last_sync_at === "string" ? d.last_sync_at : null,
        lastSyncErrorAt: typeof d.last_sync_error_at === "string" ? d.last_sync_error_at : null,
        ...(typeof d.auto_join === "boolean" ? { autoJoin: d.auto_join } : {}),
        ...(error?.code === "SAMO-CALENDAR-005" ? { errorCode: error.code } : {}),
      };
    },
    async startCalendarConnect() {
      const res = await post("/calendar/connect/start", {});
      if (!res.ok) await throwTyped(res, "SAMO-CALENDAR-500");
      const d = (await res.json()) as { authorization_url?: unknown };
      if (typeof d.authorization_url !== "string") throw new Error("Invalid calendar authorization response");
      return { authorizationUrl: d.authorization_url };
    },
    async disconnectCalendar() {
      const res = await fetch(`${baseUrl}/calendar/connection`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-CALENDAR-500");
    },
    async updateCalendarAutoJoin(autoJoin) {
      const res = await fetch(`${baseUrl}/calendar/connection`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ auto_join: autoJoin }), credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-CALENDAR-500");
      const d = (await res.json()) as Record<string, unknown>;
      return { provider: "google", state: d.state === "connected" || d.state === "broken" ? d.state : "not_connected", connectedAt: typeof d.connected_at === "string" ? d.connected_at : null, lastSyncAt: typeof d.last_sync_at === "string" ? d.last_sync_at : null, lastSyncErrorAt: typeof d.last_sync_error_at === "string" ? d.last_sync_error_at : null, autoJoin: d.auto_join === true };
    },
    async setCalendarMeetingExcluded(eventId, excluded) {
      const res = await fetch(`${baseUrl}/calendar/meetings/${encodeURIComponent(eventId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ excluded }), credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-CALENDAR-006");
      const d = (await res.json()) as Record<string, unknown>;
      if (typeof d.id !== "string" || typeof d.excluded !== "boolean") throw new Error("Invalid calendar meeting exclusion response");
      return { id: d.id, excluded: d.excluded };
    },
    async listCalendarMeetings(limit) {
      const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
      const res = await fetch(`${baseUrl}/calendar/meetings${query}`, { credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-CALENDAR-006");
      const d = (await res.json()) as Record<string, unknown>;
      const state: CalendarConnectionState = d.connection_state === "connected" || d.connection_state === "broken" ? d.connection_state : "not_connected";
      const error = typeof d.error === "object" && d.error !== null ? d.error as Record<string, unknown> : null;
      const responses = ["needsAction", "declined", "tentative", "accepted"];
      const rows = Array.isArray(d.meetings) ? d.meetings : [];
      const meetings = rows.filter((raw): raw is Record<string, unknown> => {
        const r = raw as Record<string, unknown>;
        return typeof r?.id === "string" && typeof r.title === "string" && typeof r.starts_at === "string" && typeof r.ends_at === "string" && typeof r.all_day === "boolean" && (r.meeting_url === null || typeof r.meeting_url === "string") && (r.meeting_provider === null || r.meeting_provider === "google_meet" || r.meeting_provider === "zoom") && (r.organizer_email === null || typeof r.organizer_email === "string") && (r.attendee_response === null || responses.includes(String(r.attendee_response)));
      }).map((r) => ({ id: r.id as string, title: r.title as string, startsAt: r.starts_at as string, endsAt: r.ends_at as string, allDay: r.all_day as boolean, meetingUrl: r.meeting_url as string | null, meetingProvider: r.meeting_provider as MeetingProvider | null, organizerEmail: r.organizer_email as string | null, attendeeResponse: r.attendee_response as CalendarMeeting["attendeeResponse"], ...(typeof r.auto_join_excluded === "boolean" ? { autoJoinExcluded: r.auto_join_excluded } : {}) }));
      return { connectionState: state, meetings, lastSyncAt: typeof d.last_sync_at === "string" ? d.last_sync_at : null, ...(typeof d.auto_join === "boolean" ? { autoJoin: d.auto_join } : {}), ...(error?.code === "SAMO-CALENDAR-005" ? { errorCode: error.code } : {}) };
    },
    async verifyMagicLink(token) {
      const res = await fetch(
        `${baseUrl}/auth/callback?token=${encodeURIComponent(token)}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) await throwTyped(res, "SAMO-AUTH-001");
    },
    async logout() {
      const res = await post("/auth/logout", {});
      if (!res.ok) await throwTyped(res, "SAMO-AUTH-LOGOUT");
    },
    async createCall(input) {
      // SPEC §5.2: app-api reads `meeting_url` (snake_case). The web `Call` type
      // is camelCase; serialize to the server contract, deserialize back.
      const res = await post("/calls", { meeting_url: input.meetingUrl });
      if (!res.ok) await throwTyped(res, "SAMO-CALL-URL");
      const data = (await res.json()) as {
        id: string;
        status: CallStatus;
        created_at?: unknown;
      };
      return toCall(
        data.id,
        input.meetingUrl,
        data.status,
        undefined,
        typeof data.created_at === "string" ? data.created_at : undefined,
      );
    },
    async deleteCall(callId) {
      const res = await fetch(`${baseUrl}/calls/${encodeURIComponent(callId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      // 204 No Content on success; a cross-tenant/unknown call is 404 (RLS-hidden).
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
    },
    async getCall(callId) {
      const res = await fetch(`${baseUrl}/calls/${encodeURIComponent(callId)}`, {
        credentials: "same-origin",
      });
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      const data = (await res.json()) as {
        id?: unknown;
        meeting_url?: unknown;
        status?: unknown;
        status_reason?: unknown;
        created_at?: unknown;
      };
      return toCall(
        typeof data.id === "string" ? data.id : callId,
        typeof data.meeting_url === "string" ? data.meeting_url : "",
        data.status as CallStatus,
        typeof data.status_reason === "string" ? data.status_reason : undefined,
        typeof data.created_at === "string" ? data.created_at : undefined,
      );
    },
    async deleteAccount() {
      const res = await fetch(`${baseUrl}/account`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      // 200 on success (the server clears the session cookie); a stale/dead
      // session is 401. Surface any failure as a typed error, never a hang.
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
    },
    async listCalls() {
      const res = await fetch(`${baseUrl}/calls`, { credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-CALL-LIST");
      const data = (await res.json()) as {
        calls?: Array<{
          id?: unknown;
          meeting_url?: unknown;
          status?: unknown;
          status_reason?: unknown;
          created_at?: unknown;
        }>;
      };
      const rows = Array.isArray(data.calls) ? data.calls : [];
      return rows
        .filter(
          (
            r,
          ): r is {
            id: string;
            meeting_url: string;
            status: CallStatus;
            status_reason?: unknown;
            created_at?: unknown;
          } => typeof r.id === "string" && typeof r.meeting_url === "string",
        )
        .map((r) =>
          toCall(
            r.id,
            r.meeting_url,
            r.status,
            typeof r.status_reason === "string" ? r.status_reason : undefined,
            typeof r.created_at === "string" ? r.created_at : undefined,
          ),
        );
    },
    async getSettings() {
      const res = await fetch(`${baseUrl}/settings`, { credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-SETTINGS-GET");
      const data = (await res.json()) as Record<string, never>;
      return { ...toSettingsSnapshot(data), signin: toSignIn((data as { signin?: unknown }).signin) };
    },
    async saveSettings(input) {
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settingsToWire(input)),
        credentials: "same-origin",
      });
      if (!res.ok) await throwTyped(res, "SAMO-SETTINGS-PUT");
      return toSettingsSnapshot((await res.json()) as Record<string, never>);
    },
    async lastDevMagicLink(email) {
      if (process.env.NODE_ENV === "production") return null;
      try {
        const res = await fetch(
          `${baseUrl}/__dev/last-magic-link?email=${encodeURIComponent(email)}`,
          { credentials: "same-origin" },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { link?: unknown };
        return typeof data.link === "string" ? data.link : null;
      } catch {
        return null;
      }
    },
  };
}
