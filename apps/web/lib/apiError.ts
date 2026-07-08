/**
 * Shared typed error + wire-error decoder for the web API clients
 * (appApiClient + shareApiClient) — the AppApiError shape and the body→error
 * mapping live in one place (SPEC §5.16 stable codes).
 */

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

/**
 * Stable §5.16 code for a stale session whose tenant no longer exists (#114,
 * §5.14). app-api returns it as a 401 that also clears the session cookie.
 */
export const SESSION_INVALID_CODE = "SAMO-AUTH-005";

/**
 * Canonical "you've been signed out" copy — shown for a stale-session failure
 * instead of the generic "Request failed." The web owns this string so the copy
 * is stable even when the wire body carries only a fallback message.
 */
export const SESSION_INVALID_MESSAGE =
  "You've been signed out. Please sign in again.";

/**
 * True when a failure means the caller's session is no longer valid (the stale
 * `SAMO-AUTH-005` code, or any 401): the UI should show the signed-out copy and
 * route the user back to sign-in, not a generic error.
 */
export function isSessionInvalid(err: unknown): boolean {
  return (
    err instanceof AppApiError &&
    (err.code === SESSION_INVALID_CODE || err.status === 401)
  );
}

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
}

/** Throw a typed AppApiError from a failed Response (body code/message/retryable, else fallback). */
export async function throwTyped(res: Response, fallbackCode: string): Promise<never> {
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
