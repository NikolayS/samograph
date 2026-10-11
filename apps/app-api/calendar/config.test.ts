import { describe, expect, it } from "bun:test";
import { googleCalendarOAuthFromEnv } from "./google-calendar-oauth.ts";
import { calendarTokenEncryptionFromEnv } from "./encryption-config.ts";
import { formatCalendarStartupLine, resolveCalendarConfig } from "./resolve-config.ts";

const credentials = { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" };
describe("Calendar production configuration", () => {
  it("derives the registered web origin and accepts an exact override", () => {
    expect(googleCalendarOAuthFromEnv(credentials, "https://samograph.dev")?.redirectUri).toBe("https://samograph.dev/calendar/connect/callback");
    expect(googleCalendarOAuthFromEnv({ ...credentials, GOOGLE_CALENDAR_REDIRECT_URI: "http://localhost:3000/calendar/connect/callback" }, "https://unregistered.test")?.redirectUri).toBe("http://localhost:3000/calendar/connect/callback");
  });
  it("rejects unregistered derived origins and malformed overrides", () => {
    expect(() => googleCalendarOAuthFromEnv(credentials, "https://preview.samo.cat")).toThrow();
    expect(() => googleCalendarOAuthFromEnv({ ...credentials, GOOGLE_CALENDAR_REDIRECT_URI: "https://samograph.dev/auth/google/callback" }, "https://samograph.dev")).toThrow();
  });
  it("fails closed on missing/mismatched encryption configuration", () => {
    expect(() => calendarTokenEncryptionFromEnv({})).toThrow(/CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION/);
    const encoded = Buffer.alloc(32, 9).toString("base64");
    const config = calendarTokenEncryptionFromEnv({ CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION: "1", CALENDAR_TOKEN_ENCRYPTION_KEY: encoded, CALENDAR_TOKEN_DECRYPTION_KEYS: JSON.stringify({ 1: encoded }) });
    expect(config.activeKeyVersion).toBe(1);
    expect(config.decryptionKeys.get(1)?.equals(Buffer.alloc(32, 9))).toBe(true);
  });
});

describe("resolveCalendarConfig — Calendar is explicitly opt-in (#240)", () => {
  const encoded = Buffer.alloc(32, 9).toString("base64");
  const calendarKeys = {
    CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION: "1",
    CALENDAR_TOKEN_ENCRYPTION_KEY: encoded,
    CALENDAR_TOKEN_DECRYPTION_KEYS: JSON.stringify({ 1: encoded }),
  };

  it("regression: Google sign-in credentials without CALENDAR_TOKEN_* boot with Calendar disabled", () => {
    const config = resolveCalendarConfig(credentials, "https://samograph.dev");
    expect(config.googleCalendarOAuth).toBeUndefined();
    expect(config.calendarTokenEncryption).toBeUndefined();
  });

  it("all empty CALENDAR_TOKEN_* values disable Calendar without throwing", () => {
    const config = resolveCalendarConfig({
      ...credentials,
      CALENDAR_TOKEN_ENCRYPTION_KEY: "",
      CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION: "",
      CALENDAR_TOKEN_DECRYPTION_KEYS: "",
    }, "https://samograph.dev");
    expect(config).toEqual({
      googleCalendarOAuth: undefined,
      calendarTokenEncryption: undefined,
    });
  });

  it("all whitespace-only CALENDAR_TOKEN_* values disable Calendar without throwing", () => {
    const config = resolveCalendarConfig({
      ...credentials,
      CALENDAR_TOKEN_ENCRYPTION_KEY: "   ",
      CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION: "   ",
      CALENDAR_TOKEN_DECRYPTION_KEYS: "   ",
    }, "https://samograph.dev");
    expect(config).toEqual({
      googleCalendarOAuth: undefined,
      calendarTokenEncryption: undefined,
    });
  });

  it("one real CALENDAR_TOKEN_* value plus two empty values fails as partial configuration", () => {
    expect(() => resolveCalendarConfig({
      ...credentials,
      CALENDAR_TOKEN_ENCRYPTION_KEY: encoded,
      CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION: "",
      CALENDAR_TOKEN_DECRYPTION_KEYS: "",
    }, "https://samograph.dev")).toThrow("CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION must be a positive integer");
  });

  it("Google sign-in credentials plus all CALENDAR_TOKEN_* enable Calendar", () => {
    const config = resolveCalendarConfig({ ...credentials, ...calendarKeys }, "https://samograph.dev");
    expect(config.googleCalendarOAuth).toBeDefined();
    expect(config.calendarTokenEncryption?.activeKeyVersion).toBe(1);
  });

  it("Calendar keys without Google sign-in credentials report Calendar disabled", () => {
    const config = resolveCalendarConfig(calendarKeys, "https://samograph.dev");
    expect(config.googleCalendarOAuth).toBeUndefined();
    expect(formatCalendarStartupLine(config)).toBe(
      "  Google Calendar: disabled (Google sign-in not configured)\n",
    );
  });

  it("Google sign-in credentials plus only CALENDAR_TOKEN_ENCRYPTION_KEY fail closed", () => {
    expect(() => resolveCalendarConfig({
      ...credentials,
      CALENDAR_TOKEN_ENCRYPTION_KEY: encoded,
    }, "https://samograph.dev")).toThrow(/CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION/);
  });

  it("no Google sign-in credentials leave both providers disabled without throwing", () => {
    const config = resolveCalendarConfig({}, "https://samograph.dev");
    expect(config.googleCalendarOAuth).toBeUndefined();
    expect(config.calendarTokenEncryption).toBeUndefined();
  });
});
