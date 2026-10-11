/**
 * Shared crypto primitives (Bun built-in `node:crypto` only — SPEC §6.2 #6).
 *
 * `sha256Hex` was copy-pasted at ~6 sites (ingest_secret / worker_secret /
 * share-token / disclosure-payload hashing). It is a plain digest, NOT a
 * timing-sensitive compare — a constant-time equality check lives in the auth
 * layer (`apps/app-api/auth/crypto.ts::constantTimeEqual`, `timingSafeEqual`).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export type SecretEncryptionErrorCode =
  | "INVALID_KEY"
  | "INVALID_KEY_VERSION"
  | "DECRYPTION_FAILED";

export class SecretEncryptionError extends Error {
  constructor(readonly code: SecretEncryptionErrorCode) {
    super(code === "DECRYPTION_FAILED" ? "Secret decryption failed" : "Invalid encryption configuration");
    this.name = "SecretEncryptionError";
  }
}

export function parseAes256Key(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(value)) {
    throw new SecretEncryptionError("INVALID_KEY");
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== value) {
    throw new SecretEncryptionError("INVALID_KEY");
  }
  return key;
}

export function encryptSecret(
  plaintext: string,
  key: Buffer,
  keyVersion: number,
  aad: string,
): EncryptedSecret {
  assertKey(key);
  if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
    throw new SecretEncryptionError("INVALID_KEY_VERSION");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion };
}

export function decryptSecret(encrypted: EncryptedSecret, key: Buffer, aad: string): string {
  try {
    assertKey(key);
    if (
      !Number.isSafeInteger(encrypted.keyVersion) ||
      encrypted.keyVersion <= 0 ||
      encrypted.iv.byteLength !== 12 ||
      encrypted.tag.byteLength !== 16
    ) {
      throw new Error("invalid encrypted secret");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv, {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(encrypted.tag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretEncryptionError("DECRYPTION_FAILED");
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) {
    throw new SecretEncryptionError("INVALID_KEY");
  }
}

/** SHA-256 of a UTF-8 string (or bytes), hex-encoded. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
