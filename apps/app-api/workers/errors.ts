/**
 * Typed error envelope for the worker-discovery surface (SPEC §5.16).
 *
 * `SAMO-WORKER-503` is the single failure this seam renders: a per-call
 * bot-worker that is unreachable — crashed, mid-restart, or a stale `workers`
 * row whose process is gone. The inter-service call is bounded (never a hang),
 * so the caller (dashboard / agent-gateway) gets a fast, retryable 503 while
 * transcript ingest keeps flowing independently (§5.8, §6.2 #9, §10 #11).
 */

/** The envelope shape returned to clients (§5.16). */
export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

/** Static reference for a typed error: HTTP status + user-facing copy. */
export interface ApiErrorInfo extends ApiErrorBody {
  httpStatus: number;
}

/** `SAMO-WORKER-503` — bot-worker unreachable (crash/stale row); retry once (§5.16). */
export const WORKER_UNAVAILABLE = "SAMO-WORKER-503" as const;

export const WORKER_ERRORS: Record<string, ApiErrorInfo> = {
  [WORKER_UNAVAILABLE]: {
    code: WORKER_UNAVAILABLE,
    httpStatus: 503,
    message: "That action is temporarily unavailable.",
    retryable: true,
  },
};

/** Render a typed worker error code as its `{ code, message, retryable }` response. */
export function workerErrorResponse(code: string): Response {
  const info = WORKER_ERRORS[code] ?? WORKER_ERRORS[WORKER_UNAVAILABLE];
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
