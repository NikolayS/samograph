/**
 * Shared crypto primitives (Bun built-in `node:crypto` only — SPEC §6.2 #6).
 *
 * `sha256Hex` was copy-pasted at ~6 sites (ingest_secret / worker_secret /
 * share-token / disclosure-payload hashing). It is a plain digest, NOT a
 * timing-sensitive compare — a constant-time equality check lives in the auth
 * layer (`apps/app-api/auth/crypto.ts::constantTimeEqual`, `timingSafeEqual`).
 */
import { createHash } from "node:crypto";

/** SHA-256 of a UTF-8 string (or bytes), hex-encoded. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
