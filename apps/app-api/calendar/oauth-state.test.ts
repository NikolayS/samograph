import { describe, expect, it } from "bun:test";
import {
  CALENDAR_OAUTH_COOKIE_NAME,
  CALENDAR_OAUTH_PURPOSE,
  buildCalendarOAuthStateCookie,
  issueCalendarOAuthStateCookie,
  verifyCalendarOAuthStateForCallback,
} from "./oauth-state.ts";
import { OAUTH_STATE_COOKIE_NAME, codeChallengeS256 } from "../auth/oauth-state.ts";

describe("calendar OAuth state", () => {
  it("uses a separate __Host cookie and HMAC purpose", () => {
    expect(CALENDAR_OAUTH_COOKIE_NAME).toBe("__Host-samo_calendar_oauth");
    expect(CALENDAR_OAUTH_COOKIE_NAME).not.toBe(OAUTH_STATE_COOKIE_NAME);
    expect(CALENDAR_OAUTH_PURPOSE).toBe("samo.calendar.oauth.state.v1|");
    expect(buildCalendarOAuthStateCookie("sealed")).toBe(
      "__Host-samo_calendar_oauth=sealed; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
    );
  });

  it("pins the RFC 7636 S256 known-answer vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("binds state to the initiating user and tenant and expires after ten minutes", () => {
    const header = issueCalendarOAuthStateCookie(
      { state: "state", codeVerifier: "verifier", userId: "user-a", tenantId: "tenant-a" },
      "secret", () => 1_000,
    );
    const value = header.match(/^[^=]+=([^;]+)/)?.[1] ?? "";
    expect(verifyCalendarOAuthStateForCallback(value, "secret", "state", "user-a", "tenant-a", 601_000)?.codeVerifier).toBe("verifier");
    expect(verifyCalendarOAuthStateForCallback(value, "secret", "state", "user-b", "tenant-a", 1_001)).toBeNull();
    expect(verifyCalendarOAuthStateForCallback(value, "secret", "state", "user-a", "tenant-b", 1_001)).toBeNull();
    expect(verifyCalendarOAuthStateForCallback(value, "secret", "state", "user-a", "tenant-a", 601_001)).toBeNull();
  });
});
