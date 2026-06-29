/**
 * Signed session cookie issued on successful magic-link callback (SPEC §5.1).
 *
 * The cookie value is `base64url(claimsJson) "." base64url(hmac)` — an HMAC the
 * server verifies constant-time on every request (the tenancy gate §5.6 reads
 * it to derive the `read` scope). Cookie attributes are fixed: HttpOnly (no JS
 * access), Secure (HTTPS only), SameSite=Lax (sent on top-level navigations so
 * the magic-link click lands signed-in, but not on cross-site POSTs).
 */
import type { Clock } from "./types.ts";

export const SESSION_COOKIE_NAME = "samo_session";
/** Session lifetime: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  userId: string;
  tenantId: string;
  iat: number;
}

/** Sign session claims into an opaque, tamper-evident cookie value. */
export function signSession(_claims: SessionClaims, _secret: string): string {
  throw new Error("not implemented: signSession");
}

/** Verify + decode a session cookie value, or null if tampered/malformed. */
export function verifySession(_value: string, _secret: string): SessionClaims | null {
  throw new Error("not implemented: verifySession");
}

/**
 * Build the `Set-Cookie` header value with the fixed security attributes.
 * `maxAgeMs` defaults to {@link SESSION_TTL_MS}.
 */
export function buildSessionCookie(
  _value: string,
  _opts?: { maxAgeMs?: number },
): string {
  throw new Error("not implemented: buildSessionCookie");
}

/** Convenience: sign claims dated by `clock` and return the Set-Cookie header. */
export function issueSessionCookie(
  _claims: Omit<SessionClaims, "iat">,
  _secret: string,
  _clock: Clock,
): string {
  throw new Error("not implemented: issueSessionCookie");
}
