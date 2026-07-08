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
import { base64url, fromBase64url, hmacSha256, constantTimeEqual } from "./crypto.ts";

export const SESSION_COOKIE_NAME = "samo_session";
/** Session lifetime: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  userId: string;
  tenantId: string;
  iat: number;
}

/** Sign session claims into an opaque, tamper-evident cookie value. */
export function signSession(claims: SessionClaims, secret: string): string {
  const payloadB64 = base64url(JSON.stringify(claims));
  const sig = hmacSha256(secret, payloadB64);
  return `${payloadB64}.${base64url(sig)}`;
}

/**
 * Verify + decode a session cookie value, or null if tampered/malformed/expired.
 *
 * `now` (epoch **milliseconds**, defaulting to {@link Date.now}) is the clock the
 * server-side TTL is measured against: after the constant-time HMAC compare AND
 * the claim-shape check succeed, the session is rejected when it is older than
 * {@link SESSION_TTL_MS} (`now - iat > SESSION_TTL_MS`). Because `now` defaults
 * to the wall clock, a caller that forgets to thread it still ENFORCES the TTL —
 * it can never silently bypass it. `iat` is epoch MILLISECONDS (see
 * {@link issueSessionCookie}), so `now` MUST be milliseconds too — do NOT pass a
 * seconds clock, or every session reads ~1000× too old and 401s.
 *
 * The TTL check runs strictly AFTER the constant-time HMAC compare so `iat` is
 * never reachable without a valid signature (no pre-auth timing oracle on iat).
 */
export function verifySession(
  value: string,
  secret: string,
  now: number = Date.now(),
): SessionClaims | null {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const expected = hmacSha256(secret, payloadB64);
  const actual = fromBase64url(sigB64);
  if (!constantTimeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.userId !== "string" ||
    typeof c.tenantId !== "string" ||
    typeof c.iat !== "number"
  ) {
    return null;
  }
  // Server-side TTL (§5.1): a captured cookie must not verify forever. Reject
  // once it is older than the session lifetime. `>` is strict, so a session that
  // is exactly SESSION_TTL_MS old is still accepted.
  if (now - c.iat > SESSION_TTL_MS) return null;
  return { userId: c.userId, tenantId: c.tenantId, iat: c.iat };
}

/**
 * Build the `Set-Cookie` header value with the fixed security attributes.
 * `maxAgeMs` defaults to {@link SESSION_TTL_MS}.
 */
export function buildSessionCookie(
  value: string,
  opts?: { maxAgeMs?: number },
): string {
  const maxAgeSec = Math.floor((opts?.maxAgeMs ?? SESSION_TTL_MS) / 1000);
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/**
 * Build the `Set-Cookie` header value that CLEARS the session cookie: an empty
 * value with `Max-Age=0` unsets it in the browser, while keeping the same fixed
 * security attributes (Path/HttpOnly/Secure/SameSite) so the clear targets the
 * exact cookie that {@link buildSessionCookie} set. This IS logout: the session
 * is a stateless HMAC with no server-side record to delete.
 */
export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Convenience: sign claims dated by `clock` and return the Set-Cookie header. */
export function issueSessionCookie(
  claims: Omit<SessionClaims, "iat">,
  secret: string,
  clock: Clock,
): string {
  const value = signSession({ ...claims, iat: clock() }, secret);
  return buildSessionCookie(value);
}
