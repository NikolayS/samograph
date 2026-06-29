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
import type { MeetingProvider } from "./validateMeetingUrl.ts";

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
  /** `POST /calls {meetingUrl}` — creates a Call (returned at status `PENDING`). */
  createCall(input: CreateCallInput): Promise<Call>;
}

/** Typed failure carrying a stable SPEC §5.16 code (e.g. `SAMO-AUTH-002`). */
export class AppApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AppApiError";
    this.code = code;
    this.retryable = retryable;
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
    throw new AppApiError(code, message, retryable);
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
      const res = await post("/calls", { meetingUrl: input.meetingUrl });
      if (!res.ok) await throwTyped(res, "SAMO-CALL-JOIN");
      return (await res.json()) as Call;
    },
  };
}
