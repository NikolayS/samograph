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

/** Base64url-encode bytes or a UTF-8 string (no padding, URL-safe alphabet). */
export function base64url(_data: Uint8Array | Buffer | string): string {
  throw new Error("not implemented: base64url");
}

/** Decode a base64url string back to raw bytes. */
export function fromBase64url(_s: string): Buffer {
  throw new Error("not implemented: fromBase64url");
}

/** HMAC-SHA256 of `message` under `key`, as raw 32 bytes. */
export function hmacSha256(_key: string | Buffer, _message: string): Buffer {
  throw new Error("not implemented: hmacSha256");
}

/**
 * Constant-time buffer equality. Returns false for unequal lengths (the
 * security-sensitive callers always compare two same-length HMAC digests, so
 * that branch never fires on the hot path); otherwise compares every byte in
 * time independent of where the first difference is.
 */
export function constantTimeEqual(_a: Buffer, _b: Buffer): boolean {
  throw new Error("not implemented: constantTimeEqual");
}
