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
