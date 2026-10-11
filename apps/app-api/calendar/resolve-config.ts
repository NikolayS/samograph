import type { CalendarTokenEncryptionConfig } from "./encryption-config.ts";
import { calendarTokenEncryptionFromEnv } from "./encryption-config.ts";
import type { GoogleCalendarOAuth } from "./google-calendar-oauth.ts";
import { googleCalendarOAuthFromEnv } from "./google-calendar-oauth.ts";
import { present } from "../../../packages/shared/config/env.ts";

export interface ResolvedCalendarConfig {
  googleCalendarOAuth: GoogleCalendarOAuth | undefined;
  calendarTokenEncryption: CalendarTokenEncryptionConfig | undefined;
}

export function formatCalendarStartupLine(
  config: ResolvedCalendarConfig,
): string {
  if (!config.calendarTokenEncryption) {
    return "  Google Calendar: disabled (no CALENDAR_TOKEN_* configured)\n";
  }
  return config.googleCalendarOAuth
    ? "  Google Calendar: enabled\n"
    : "  Google Calendar: disabled (Google sign-in not configured)\n";
}

const CALENDAR_TOKEN_ENV_KEYS = [
  "CALENDAR_TOKEN_ENCRYPTION_KEY",
  "CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION",
  "CALENDAR_TOKEN_DECRYPTION_KEYS",
] as const;

/**
 * Calendar is an explicit opt-in layered on Google sign-in. With no Calendar
 * token variables it is disabled; once any is supplied, the existing strict
 * validator owns partial and malformed configuration errors.
 */
export function resolveCalendarConfig(
  env: Record<string, string | undefined>,
  webOrigin: string,
): ResolvedCalendarConfig {
  const calendarRequested = CALENDAR_TOKEN_ENV_KEYS.some((key) => present(env[key]) !== undefined);
  if (!calendarRequested) {
    return { googleCalendarOAuth: undefined, calendarTokenEncryption: undefined };
  }

  const calendarTokenEncryption = calendarTokenEncryptionFromEnv(env);
  const googleCalendarOAuth = googleCalendarOAuthFromEnv(env, webOrigin);
  return { googleCalendarOAuth, calendarTokenEncryption };
}
