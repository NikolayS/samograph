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

/** Verify + decode a session cookie value, or null if tampered/malformed. */
export function verifySession(value: string, secret: string): SessionClaims | null {
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

/** Convenience: sign claims dated by `clock` and return the Set-Cookie header. */
export function issueSessionCookie(
  claims: Omit<SessionClaims, "iat">,
  secret: string,
  clock: Clock,
): string {
  const value = signSession({ ...claims, iat: clock() }, secret);
  return buildSessionCookie(value);
}
