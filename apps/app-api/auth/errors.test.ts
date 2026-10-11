/**
 * The §5.16 SAMO-AUTH error reference (SPEC amendment S5-1 item 10).
 *
 * `SAMO-AUTH-006` … `010` are the Google sign-in codes. They are delivered as a
 * `302 → /auth?error=<CODE>` — a browser redirect carries no JSON body — so the
 * `httpStatus` recorded here is **302**, which S5-1 explicitly left for this PR
 * to pin.
 *
 * The `message` strings are asserted VERBATIM because they are a contract, not
 * copy: `apps/web/lib/authErrors.ts` renders the same code→copy map on the sign-in
 * page and pins the identical strings in its own tests. A silent edit on either
 * side is a user-visible drift, so both sides assert the exact bytes.
 */
import { describe, it, expect } from "bun:test";
import { AUTH_ERRORS } from "./errors.ts";
import type { AuthErrorCode } from "./types.ts";

describe("AUTH_ERRORS — the §5.16 Google rows (006–010)", () => {
  it("SAMO-AUTH-006 is the user cancelling at Google — 302, retryable", () => {
    expect(AUTH_ERRORS["SAMO-AUTH-006"]).toEqual({
      code: "SAMO-AUTH-006",
      httpStatus: 302,
      message: "Sign-in cancelled. Choose a way to sign in below.",
      retryable: true,
    });
  });

  it("SAMO-AUTH-007 is the state/PKCE/nonce bucket — 302, retryable", () => {
    expect(AUTH_ERRORS["SAMO-AUTH-007"]).toEqual({
      code: "SAMO-AUTH-007",
      httpStatus: 302,
      message: "That sign-in attempt expired — please try again.",
      retryable: true,
    });
  });

  it("SAMO-AUTH-008 is the Google-side / ID-token bucket — 302, retryable", () => {
    expect(AUTH_ERRORS["SAMO-AUTH-008"]).toEqual({
      code: "SAMO-AUTH-008",
      httpStatus: 302,
      message: "Google couldn't sign you in right now.",
      retryable: true,
    });
  });

  it("SAMO-AUTH-009 is the email_verified gate — 302, NOT retryable", () => {
    expect(AUTH_ERRORS["SAMO-AUTH-009"]).toEqual({
      code: "SAMO-AUTH-009",
      httpStatus: 302,
      message: "Your Google account's email isn't verified.",
      retryable: false,
    });
  });

  it("SAMO-AUTH-010 is 'not configured on this deployment' — 302, NOT retryable", () => {
    expect(AUTH_ERRORS["SAMO-AUTH-010"]).toEqual({
      code: "SAMO-AUTH-010",
      httpStatus: 302,
      message: "Google sign-in isn't available here.",
      retryable: false,
    });
  });

  it("covers every AuthErrorCode with no extra rows", () => {
    const codes: AuthErrorCode[] = [
      "SAMO-AUTH-001",
      "SAMO-AUTH-002",
      "SAMO-AUTH-003",
      "SAMO-AUTH-004",
      "SAMO-AUTH-005",
      "SAMO-AUTH-006",
      "SAMO-AUTH-007",
      "SAMO-AUTH-008",
      "SAMO-AUTH-009",
      "SAMO-AUTH-010",
      "SAMO-AUTH-500",
      "SAMO-CALENDAR-001",
      "SAMO-CALENDAR-002",
      "SAMO-CALENDAR-003",
      "SAMO-CALENDAR-004",
      "SAMO-CALENDAR-005",
      "SAMO-CALENDAR-006",
      "SAMO-CALENDAR-500",
    ];
    expect(Object.keys(AUTH_ERRORS).sort()).toEqual([...codes].sort());
    for (const code of codes) expect(AUTH_ERRORS[code].code).toBe(code);
  });
});
