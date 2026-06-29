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

export function isAuthErrorCode(code: string): code is AuthErrorCode {
  return (AUTH_ERROR_CODES as readonly string[]).includes(code);
}

export function authErrorMessage(code: string): string {
  return isAuthErrorCode(code) ? AUTH_ERROR_MESSAGES[code] : AUTH_FALLBACK_MESSAGE;
}
