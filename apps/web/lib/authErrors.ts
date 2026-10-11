/**
 * Auth error codes and their exact user-facing copy (SPEC §5.16).
 *
 * Two delivery shapes, ONE map. The magic-link callback page switches on the
 * stable `SAMO-AUTH-00x` code in the `/auth/callback` JSON envelope; the Google
 * callback cannot return a body at all (it 302s the browser), so it appends
 * `?error=<CODE>` to `/auth` and the sign-in page renders the same string.
 * Codes are stable and safe to switch on.
 *
 * ONE union, derived — not a second copy of the list (#219). This map used to
 * declare its own `AuthErrorCode` union alongside the app-api's in
 * `apps/app-api/auth/types.ts`, with no link between them. Nothing failed
 * when they drifted: `tsc --noEmit` stayed green while `/auth/google/callback`
 * redirected to `?error=SAMO-AUTH-500`, a code this map had no row for, so a
 * retryable failure that was entirely OUR fault told the user their *link* was
 * bad and to request a new one — when they had clicked "Continue with Google"
 * and never used a link at all.
 *
 * So the union is now DERIVED from the app-api's declaration, minus an explicit
 * {@link SERVER_INTERNAL_AUTH_ERROR_CODES} list. `AUTH_ERROR_MESSAGES` is a
 * `Record` over that derived union, which makes the invariant a BUILD error:
 * add a code in `apps/app-api/auth/types.ts` and `tsc --noEmit` fails here until
 * it has copy (or is explicitly declared server-internal). `authErrors.test.ts`
 * pins the same invariant at test time against `AUTH_ERRORS`, the app-api's own
 * §5.16 table, including that the strings are byte-identical on both sides.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`. The import below
 * is `import type`, so it is erased at build time and no app-api code, and no
 * server dependency of any kind, reaches the browser bundle.
 */
import type { AuthErrorCode as AppApiAuthErrorCode } from "../../app-api/auth/types.ts";

/**
 * Codes the app-api NEVER hands the browser as a renderable code, and which
 * therefore need no copy row here. The invariant is not "the two unions are
 * equal" — it is "every code that can reach the browser has copy".
 *
 * `SAMO-AUTH-005` is the only one: a stateless session cookie that outlived its
 * tenant (#114, §5.14) is answered with a 401 + clear-cookie, after which the
 * web simply redirects to sign-in. The code rides no `?error=` and no rendered
 * envelope, so mapping it would be inventing a screen that cannot happen.
 *
 * Adding to this list is how you say "this code is server-internal". It is
 * asserted literally in `authErrors.test.ts`, so it cannot be quietly grown to
 * silence a missing-copy failure.
 */
export const SERVER_INTERNAL_AUTH_ERROR_CODES = ["SAMO-AUTH-005"] as const;

type ServerInternalAuthErrorCode = (typeof SERVER_INTERNAL_AUTH_ERROR_CODES)[number];

/** Every §5.16 code that can reach the browser — the app-api union, minus the above. */
export type AuthErrorCode = Exclude<AppApiAuthErrorCode, ServerInternalAuthErrorCode>;

/**
 * The copy, keyed by the derived union — so this object IS the exhaustiveness
 * check. A new app-api code with no row here is a compile error, not a user
 * staring at the wrong sentence.
 *
 * Strings are byte-identical to `AUTH_ERRORS[code].message` in
 * `apps/app-api/auth/errors.ts` and asserted verbatim on both sides: they are a
 * contract, not decoration.
 */
const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  "SAMO-AUTH-001": "This sign-in link isn't valid.",
  "SAMO-AUTH-002": "This sign-in link has expired.",
  "SAMO-AUTH-003": "This link was already used.",
  "SAMO-AUTH-004": "Too many sign-in attempts — try again shortly.",
  // Google sign-in (issue #209 / SPEC.amendments S5-1). These never arrive in a
  // JSON body: the Google callback is a browser redirect, so it hands the code
  // back as `/auth?error=<CODE>` and the sign-in page renders it from this same
  // map.
  "SAMO-AUTH-006": "Sign-in cancelled. Choose a way to sign in below.",
  "SAMO-AUTH-007": "That sign-in attempt expired — please try again.",
  "SAMO-AUTH-008": "Google couldn't sign you in right now.",
  "SAMO-AUTH-009": "Your Google account's email isn't verified.",
  "SAMO-AUTH-010": "Google sign-in isn't available here.",
  // Our fault, and retryable: Google's token endpoint answered 5xx, or identity
  // provisioning failed after a valid sign-in (#180, #219). Delivered BOTH as a
  // 500 + JSON body on the magic-link leg and as `?error=SAMO-AUTH-500` on the
  // Google leg — on the latter the status is 302 whatever happened, so this row
  // is the only thing that keeps the message honest.
  "SAMO-AUTH-500": "Something went wrong on our end — please try again.",
  "SAMO-CALENDAR-001": "Google Calendar isn’t available here.",
  "SAMO-CALENDAR-002": "Google Calendar wasn’t connected.",
  "SAMO-CALENDAR-003": "That Google Calendar connection expired. Please try again.",
  "SAMO-CALENDAR-004": "Google Calendar couldn’t be connected. Please try again.",
  "SAMO-CALENDAR-005": "Google Calendar needs to be reconnected.",
  "SAMO-CALENDAR-006": "Upcoming meetings couldn’t be refreshed. Please try again.",
  "SAMO-CALENDAR-500": "Something went wrong connecting Google Calendar.",
};

/**
 * The mapped codes, derived from the copy map so the list and the map cannot
 * disagree. (They used to be written out twice.)
 */
export const AUTH_ERROR_CODES = Object.keys(AUTH_ERROR_MESSAGES) as readonly AuthErrorCode[];

/**
 * Codes that report a normal outcome rather than a failure. §5.16 (S5-1) marks
 * `SAMO-AUTH-006` — the user pressed "Cancel" on Google's consent screen — as
 * "(info tone, not an error)": they did exactly what they meant to, so shouting
 * at them in `role="alert"` red would be the UI lying about what happened.
 */
export function isAuthInfoCode(code: string): boolean {
  return code === "SAMO-AUTH-006";
}

/** Shown when the server returns an unrecognized / non-auth error code. */
export const AUTH_FALLBACK_MESSAGE = "Couldn't sign you in. Request a new link.";

/**
 * Shown for infra failures (HTTP 5xx or a network error) — NOT the token itself.
 * A 5xx body often lacks a `code`, so the typed error's `code` falls back to
 * `SAMO-AUTH-001`; the callback must branch on `status`, not `code`, so it does
 * not mislead the user into thinking a valid link is invalid.
 */
export const AUTH_INFRA_MESSAGE =
  "Something went wrong on our end — please try again.";

export function isAuthErrorCode(code: string): code is AuthErrorCode {
  return (AUTH_ERROR_CODES as readonly string[]).includes(code);
}

export function authErrorMessage(code: string): string {
  return isAuthErrorCode(code) ? AUTH_ERROR_MESSAGES[code] : AUTH_FALLBACK_MESSAGE;
}
