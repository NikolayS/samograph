import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  SecretEncryptionError,
  decryptSecret,
  encryptSecret,
  parseAes256Key,
} from "./crypto.ts";

describe("AES-256-GCM secrets", () => {
  const token = "refresh-token-material";
  const aad = "samo.calendar.refresh.v1|connection|user|tenant";

  it("parses exactly one base64-encoded 32-byte key", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    expect(parseAes256Key(bytes.toString("base64"))).toEqual(bytes);

    for (const malformed of ["not base64!", Buffer.alloc(31).toString("base64"), ""]) {
      expect(() => parseAes256Key(malformed)).toThrow(SecretEncryptionError);
      try {
        parseAes256Key(malformed);
      } catch (error) {
        expect((error as SecretEncryptionError).code).toBe("INVALID_KEY");
        if (malformed.length > 0) expect(String(error)).not.toContain(malformed);
      }
    }
  });

  it("round trips exact UTF-8 plaintext with the requested key version", () => {
    const roundTripKey = randomBytes(32);
    const encrypted = encryptSecret(token, roundTripKey, 7, aad);
    expect(encrypted.iv.byteLength).toBe(12);
    expect(encrypted.tag.byteLength).toBe(16);
    expect(encrypted.keyVersion).toBe(7);
    expect(Object.keys(encrypted).sort()).toEqual(["ciphertext", "iv", "keyVersion", "tag"]);
    expect(JSON.stringify(encrypted)).not.toContain(token);
    expect(decryptSecret(encrypted, roundTripKey, aad)).toBe(token);
  });

  const key = randomBytes(32);

  it("uses a fresh IV and produces distinct ciphertext for the same token", () => {
    const first = encryptSecret(token, key, 1, aad);
    const second = encryptSecret(token, key, 1, aad);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("fails typed for modified ciphertext, IV, tag, and AAD without leaking the token", () => {
    const encrypted = encryptSecret(token, key, 1, aad);
    const attempts = [
      [{ ...encrypted, ciphertext: flipped(encrypted.ciphertext) }, aad],
      [{ ...encrypted, iv: flipped(encrypted.iv) }, aad],
      [{ ...encrypted, tag: flipped(encrypted.tag) }, aad],
      [encrypted, `${aad}-wrong`],
    ] as const;

    for (const [candidate, candidateAad] of attempts) {
      try {
        decryptSecret(candidate, key, candidateAad);
        throw new Error("expected decryption to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SecretEncryptionError);
        expect((error as SecretEncryptionError).code).toBe("DECRYPTION_FAILED");
        expect(String(error)).not.toContain(token);
        expect(JSON.stringify(error)).not.toContain(token);
      }
    }
  });

  it("decrypts with an old key and can re-encrypt with the active version", () => {
    const oldKey = randomBytes(32);
    const activeKey = randomBytes(32);
    const old = encryptSecret(token, oldKey, 1, aad);
    const plaintext = decryptSecret(old, oldKey, aad);
    const active = encryptSecret(plaintext, activeKey, 2, aad);

    expect(old.keyVersion).toBe(1);
    expect(active.keyVersion).toBe(2);
    expect(decryptSecret(active, activeKey, aad)).toBe(token);
  });

  it("rejects invalid key versions without including plaintext", () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      try {
        encryptSecret(token, key, version, aad);
        throw new Error("expected key version rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(SecretEncryptionError);
        expect((error as SecretEncryptionError).code).toBe("INVALID_KEY_VERSION");
        expect(String(error)).not.toContain(token);
      }
    }
    const encrypted = encryptSecret(token, key, 1, aad);
    expect(() => decryptSecret({ ...encrypted, keyVersion: 0 }, key, aad)).toThrow(
      SecretEncryptionError,
    );
  });
});

function flipped(value: Buffer): Buffer {
  const copy = Buffer.from(value);
  copy[0] ^= 1;
  return copy;
}
