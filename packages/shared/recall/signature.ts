/**
 * The pinned Recall webhook signing contract (SPEC §5.3 step 1).
 *
 * ONE source of truth shared by the SIGNER (the in-repo Recall fake) and the
 * VERIFIER (the ingest `POST /webhook` handler). Pinning the header name, the
 * HMAC scheme, and the exact signing input here is what guarantees the two
 * sides can never silently drift apart — and is why production ingest code
 * imports this constant rather than re-deriving it.
 *
 * Scheme (deterministic, byte-stable, network-free):
 *   - signature = HMAC-SHA256(rawBody, secret), lowercase hex
 *   - signing input = the EXACT raw request body bytes (no canonicalization)
 *   - secret = the per-region webhook secret from the secret manager (§4.4/§4.10)
 *   - transport = the `x-recall-signature` request header
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

/** Header carrying the HMAC-SHA256 signature of the raw webhook body (§5.3). */
export const RECALL_SIGNATURE_HEADER = "x-recall-signature" as const;

/**
 * HMAC-SHA256 of the EXACT raw body bytes, keyed by the per-region webhook
 * secret, lowercase-hex encoded. Accepts a string or raw bytes identically.
 */
export function recallSignature(rawBody: string | Uint8Array, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time verification of a presented signature header against the one
 * recomputed from the body + secret. Fails closed on a missing/short/empty
 * header (length is checked first so `timingSafeEqual` never throws, and a
 * length mismatch never leaks more than "wrong").
 */
export function verifyRecallSignature(
  rawBody: string | Uint8Array,
  presented: string | null | undefined,
  secret: string,
): boolean {
  if (!presented) return false;
  const expected = Buffer.from(recallSignature(rawBody, secret), "utf8");
  const got = Buffer.from(presented, "utf8");
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
