/**
 * Typed error envelope for the `/calls` routes (SPEC §5.16).
 *
 * Every API failure is typed: `{ code, message, retryable }` with the HTTP
 * status from the reference below. Authentication failures (missing/invalid
 * session) return a bodyless 401, and the tenancy gate's authorization denial
 * (`SAMO-AUTHZ-001`) is the single bodyless 403 (§5.6) — those carry their code
 * for logging, not a body. The only `/calls` failure that renders a typed JSON
 * body in v1 is the meeting-URL validation rejection below.
 */

/** The envelope shape returned to clients (§5.16). */
export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

/** Static reference for a typed `/calls` error: HTTP status + user-facing copy. */
export interface ApiErrorInfo extends ApiErrorBody {
  httpStatus: number;
}

/**
 * `SAMO-CALL-URL` — the submitted `meeting_url` is not a recognised Zoom or
 * Google Meet meeting link (§5.2 "app-api validates … known Zoom / Google Meet
 * URL pattern"). A 400 with the typed envelope; the client should fix the URL.
 *
 * This extends the §5.16 reference with a request-validation code (the table
 * there enumerates auth/authz/token/call-status codes but not input validation);
 * called out in the PR as an explicit, reviewed extension — not silent drift.
 */
export const CALL_URL_INVALID = "SAMO-CALL-URL" as const;

export const CALL_ERRORS: Record<string, ApiErrorInfo> = {
  [CALL_URL_INVALID]: {
    code: CALL_URL_INVALID,
    httpStatus: 400,
    message: "That doesn't look like a Zoom or Google Meet meeting link.",
    retryable: false,
  },
};

/** Render a typed error code as its `{ code, message, retryable }` JSON response. */
export function errorResponse(code: string): Response {
  const info = CALL_ERRORS[code];
  if (!info) {
    // Defensive: an unknown code should never be a silent hang (§5.16).
    return new Response(
      JSON.stringify({ code, message: "Unexpected error.", retryable: false }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  const body: ApiErrorBody = {
    code: info.code,
    message: info.message,
    retryable: info.retryable,
  };
  return new Response(JSON.stringify(body), {
    status: info.httpStatus,
    headers: { "content-type": "application/json" },
  });
}
