/**
 * Crypto primitives for magic-link auth — Bun's built-in `node:crypto` only,
 * no third-party deps (SPEC §6.2 #6: "Crypto/cookies via Bun built-ins").
 *
 * The signature comparison MUST be constant-time: a byte-by-byte early-exit
 * comparator leaks, via timing, how many leading bytes of a forged signature
 * are correct, turning an HMAC into an online oracle. {@link constantTimeEqual}
 * delegates to `crypto.timingSafeEqual`, which compares in time independent of
 * the contents — asserted by the statistical timing test in `crypto.test.ts`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Base64url-encode bytes or a UTF-8 string (no padding, URL-safe alphabet). */
export function base64url(data: Uint8Array | Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return buf.toString("base64url");
}

/** Decode a base64url string back to raw bytes. */
export function fromBase64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** HMAC-SHA256 of `message` under `key`, as raw 32 bytes. */
export function hmacSha256(key: string | Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/**
 * Constant-time buffer equality. Returns false for unequal lengths (the
 * security-sensitive callers always compare two same-length HMAC digests, so
 * that branch never fires on the hot path); otherwise compares every byte in
 * time independent of where the first difference is.
 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual throws on a length mismatch; a differing length is itself
  // public information (it is not the secret-dependent comparison §6.2 #6 is
  // about), so short-circuit to false before delegating to the constant-time
  // compare over equal-length buffers.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
