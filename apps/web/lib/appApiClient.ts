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
}

export interface RequestMagicLinkInput {
  email: string;
}

export interface CreateCallInput {
  meetingUrl: string;
}

export interface AppApiClient {
  /** `POST /auth/magic-link {email}` — server emails a one-time sign-in link. */
  requestMagicLink(input: RequestMagicLinkInput): Promise<void>;
  /** `GET /auth/callback?token=…` — verifies the link; throws `AppApiError` on failure. */
  verifyMagicLink(token: string): Promise<void>;
  /** `POST /auth/logout` — clears the session cookie server-side; throws `AppApiError` on failure. */
  logout(): Promise<void>;
  /** `POST /calls {meeting_url}` — creates a Call (returned at status `PENDING`). */
  createCall(input: CreateCallInput): Promise<Call>;
  /** `GET /calls` — the caller's tenant's calls (newest first); throws on 401. */
  listCalls(): Promise<Call[]>;
  /**
   * `DELETE /calls/:id` — permanently erase ONE call and all of its data
   * (transcript, share links, recording) — SPEC §5.14 GDPR per-call erasure.
   * Owner-only; throws `AppApiError` on failure.
   */
  deleteCall(callId: string): Promise<void>;
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

  /** Map a server `calls` row (snake_case, no provider) to the web `Call` shape. */
  function toCall(
    id: string,
    meetingUrl: string,
    status: CallStatus,
    statusReason?: string,
  ): Call {
    return {
      id,
      meetingUrl,
      provider: meetingProviderForUrl(meetingUrl) ?? "google_meet",
      status,
      ...(statusReason !== undefined ? { statusReason } : {}),
    };
  }

  return {
    async requestMagicLink(input) {
      const res = await post("/auth/magic-link", { email: input.email });
      if (!res.ok) await throwTyped(res, "SAMO-AUTH-004");
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
      const data = (await res.json()) as { id: string; status: CallStatus };
      return toCall(data.id, input.meetingUrl, data.status);
    },
    async deleteCall(callId) {
      const res = await fetch(`${baseUrl}/calls/${encodeURIComponent(callId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      // 204 No Content on success; a cross-tenant/unknown call is 404 (RLS-hidden).
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
          } => typeof r.id === "string" && typeof r.meeting_url === "string",
        )
        .map((r) =>
          toCall(
            r.id,
            r.meeting_url,
            r.status,
            typeof r.status_reason === "string" ? r.status_reason : undefined,
          ),
        );
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
