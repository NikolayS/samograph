/**
 * `@samograph/app-api` `/calls` surface (SPEC §4.1, §5.2, §5.6).
 *
 * Create a call from a meeting URL and read the tenant's calls back, behind the
 * magic-link session and the tenancy gate, with RLS enforced at the route's
 * `samograph_app` transaction.
 */
export {
  type ValidateResult,
  type MeetingProvider,
  validateMeetingUrl,
} from "./validate.ts";
export {
  type ApiErrorBody,
  type ApiErrorInfo,
  CALL_URL_INVALID,
  CALL_ERRORS,
  errorResponse,
} from "./errors.ts";
export {
  type CallsHandlerDeps,
  createCallsHandler,
} from "./http.ts";
