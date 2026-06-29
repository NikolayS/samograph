import { describe, it, expect } from "bun:test";
import {
  authErrorMessage,
  isAuthErrorCode,
  AUTH_FALLBACK_MESSAGE,
} from "./authErrors.ts";

describe("authErrorMessage — exact §5.16 copy for each SAMO-AUTH code", () => {
  it("maps SAMO-AUTH-001 to the exact user-facing string", () => {
    expect(authErrorMessage("SAMO-AUTH-001")).toBe("This sign-in link isn't valid.");
  });

  it("maps SAMO-AUTH-002 to the exact user-facing string", () => {
    expect(authErrorMessage("SAMO-AUTH-002")).toBe("This sign-in link has expired.");
  });

  it("maps SAMO-AUTH-003 to the exact user-facing string", () => {
    expect(authErrorMessage("SAMO-AUTH-003")).toBe("This link was already used.");
  });

  it("maps SAMO-AUTH-004 to the exact user-facing string (em dash)", () => {
    expect(authErrorMessage("SAMO-AUTH-004")).toBe(
      "Too many sign-in attempts — try again shortly.",
    );
  });

  it("returns the fallback message for an unknown code", () => {
    expect(authErrorMessage("SAMO-NOPE-999")).toBe(AUTH_FALLBACK_MESSAGE);
    expect(AUTH_FALLBACK_MESSAGE).toBe("Couldn't sign you in. Request a new link.");
  });

  it("isAuthErrorCode is a precise type guard", () => {
    expect(isAuthErrorCode("SAMO-AUTH-001")).toBe(true);
    expect(isAuthErrorCode("SAMO-AUTH-004")).toBe(true);
    expect(isAuthErrorCode("SAMO-AUTH-005")).toBe(false);
    expect(isAuthErrorCode("")).toBe(false);
  });
});
