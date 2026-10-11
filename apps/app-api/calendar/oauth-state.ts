import type { Clock } from "../auth/types.ts";
import { createSealedState } from "../auth/sealed-state.ts";

export const CALENDAR_OAUTH_COOKIE_NAME = "__Host-samo_calendar_oauth";
export const CALENDAR_OAUTH_PURPOSE = "samo.calendar.oauth.state.v1|";
export const CALENDAR_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface CalendarOAuthStateClaims {
  v: number;
  state: string;
  codeVerifier: string;
  userId: string;
  tenantId: string;
  iat: number;
}

const sealed = createSealedState<CalendarOAuthStateClaims>({
  cookieName: CALENDAR_OAUTH_COOKIE_NAME,
  purpose: CALENDAR_OAUTH_PURPOSE,
  ttlMs: CALENDAR_OAUTH_STATE_TTL_MS,
  fields: ["v", "state", "codeVerifier", "userId", "tenantId", "iat"],
  parseClaims(c) {
    if (typeof c.v !== "number" || typeof c.state !== "string" ||
      typeof c.codeVerifier !== "string" || typeof c.userId !== "string" ||
      typeof c.tenantId !== "string" || typeof c.iat !== "number") return null;
    return c as unknown as CalendarOAuthStateClaims;
  },
});

export const buildCalendarOAuthStateCookie = sealed.buildCookie;
export const buildClearedCalendarOAuthStateCookie = sealed.buildClearedCookie;
export const issueCalendarOAuthStateCookie = (
  claims: Omit<CalendarOAuthStateClaims, "v" | "iat">, secret: string, clock: Clock,
) => sealed.issueCookie(claims, secret, clock);
export const readCalendarOAuthStateCookie = sealed.readCookie;
export function verifyCalendarOAuthStateForCallback(
  value: string, secret: string, state: string | null | undefined,
  userId: string, tenantId: string, now = Date.now(),
): CalendarOAuthStateClaims | null {
  const claims = sealed.verifyCallback(value, secret, state, now);
  if (!claims) return null;
  return claims.userId === userId && claims.tenantId === tenantId ? claims : null;
}
