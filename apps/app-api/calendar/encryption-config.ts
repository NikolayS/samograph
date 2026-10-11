import { parseAes256Key } from "../../../packages/shared/crypto.ts";

export interface CalendarTokenEncryptionConfig { activeKey: Buffer; activeKeyVersion: number; decryptionKeys: Map<number, Buffer> }
export function calendarTokenEncryptionFromEnv(env: Record<string, string | undefined>): CalendarTokenEncryptionConfig {
  const version = Number(env.CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION);
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error("CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION must be a positive integer");
  if (!env.CALENDAR_TOKEN_ENCRYPTION_KEY) throw new Error("CALENDAR_TOKEN_ENCRYPTION_KEY is required");
  if (!env.CALENDAR_TOKEN_DECRYPTION_KEYS) throw new Error("CALENDAR_TOKEN_DECRYPTION_KEYS is required");
  let parsed: unknown;
  try { parsed = JSON.parse(env.CALENDAR_TOKEN_DECRYPTION_KEYS); } catch { throw new Error("CALENDAR_TOKEN_DECRYPTION_KEYS must be valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("CALENDAR_TOKEN_DECRYPTION_KEYS must be an object");
  const keys = new Map<number, Buffer>();
  for (const [rawVersion, value] of Object.entries(parsed)) {
    const keyVersion = Number(rawVersion);
    if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0 || typeof value !== "string") throw new Error("CALENDAR_TOKEN_DECRYPTION_KEYS contains an invalid entry");
    keys.set(keyVersion, parseAes256Key(value));
  }
  const activeKey = parseAes256Key(env.CALENDAR_TOKEN_ENCRYPTION_KEY);
  const readableActive = keys.get(version);
  if (!readableActive || !readableActive.equals(activeKey)) throw new Error("CALENDAR_TOKEN_DECRYPTION_KEYS must contain the active key version");
  return { activeKey, activeKeyVersion: version, decryptionKeys: keys };
}
