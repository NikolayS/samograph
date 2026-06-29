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
  /** `POST /calls {meeting_url}` — creates a Call (returned at status `PENDING`). */
  createCall(input: CreateCallInput): Promise<Call>;
  /** `GET /calls` — the caller's tenant's calls (newest first); throws on 401. */
  listCalls(): Promise<Call[]>;
  /**
   * DEV-ONLY: the most recent magic link for `email` from app-api's
   * `GET /__dev/last-magic-link`, or `null` (production, no link yet, any error).
   * Lets local testing proceed without a real inbox; a no-op in production.
   */
  lastDevMagicLink(email: string): Promise<string | null>;
}

/** Typed failure carrying a stable SPEC §5.16 code (e.g. `SAMO-AUTH-002`). */
export class AppApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** HTTP status of the failed response, when known (e.g. 401 → re-auth). */
  readonly status?: number;

  constructor(code: string, message: string, retryable = false, status?: number) {
    super(message);
    this.name = "AppApiError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
}

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

  async function throwTyped(res: Response, fallbackCode: string): Promise<never> {
    let parsed: ApiErrorBody = {};
    try {
      parsed = (await res.json()) as ApiErrorBody;
    } catch {
      parsed = {};
    }
    const code = typeof parsed.code === "string" ? parsed.code : fallbackCode;
    const message =
      typeof parsed.message === "string" ? parsed.message : "Request failed.";
    const retryable = parsed.retryable === true;
    throw new AppApiError(code, message, retryable, res.status);
  }

  /** Map a server `calls` row (snake_case, no provider) to the web `Call` shape. */
  function toCall(id: string, meetingUrl: string, status: CallStatus): Call {
    return {
      id,
      meetingUrl,
      provider: meetingProviderForUrl(meetingUrl) ?? "google_meet",
      status,
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
    async createCall(input) {
      // SPEC §5.2: app-api reads `meeting_url` (snake_case). The web `Call` type
      // is camelCase; serialize to the server contract, deserialize back.
      const res = await post("/calls", { meeting_url: input.meetingUrl });
      if (!res.ok) await throwTyped(res, "SAMO-CALL-URL");
      const data = (await res.json()) as { id: string; status: CallStatus };
      return toCall(data.id, input.meetingUrl, data.status);
    },
    async listCalls() {
      const res = await fetch(`${baseUrl}/calls`, { credentials: "same-origin" });
      if (!res.ok) await throwTyped(res, "SAMO-CALL-LIST");
      const data = (await res.json()) as {
        calls?: Array<{ id?: unknown; meeting_url?: unknown; status?: unknown }>;
      };
      const rows = Array.isArray(data.calls) ? data.calls : [];
      return rows
        .filter(
          (r): r is { id: string; meeting_url: string; status: CallStatus } =>
            typeof r.id === "string" && typeof r.meeting_url === "string",
        )
        .map((r) => toCall(r.id, r.meeting_url, r.status));
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
