/**
 * Magic-link auth error codes and their exact user-facing copy (SPEC §5.16).
 * The callback page switches on the stable `SAMO-AUTH-00x` code returned by the
 * (future) `/auth/callback` endpoint and renders the matching plain-English
 * string. Codes are stable and safe to switch on.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 */
export const AUTH_ERROR_CODES = [
  "SAMO-AUTH-001",
  "SAMO-AUTH-002",
  "SAMO-AUTH-003",
  "SAMO-AUTH-004",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  "SAMO-AUTH-001": "This sign-in link isn't valid.",
  "SAMO-AUTH-002": "This sign-in link has expired.",
  "SAMO-AUTH-003": "This link was already used.",
  "SAMO-AUTH-004": "Too many sign-in attempts — try again shortly.",
};

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
