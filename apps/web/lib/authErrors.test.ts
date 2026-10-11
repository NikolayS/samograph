import { describe, it, expect } from "bun:test";
import {
  authErrorMessage,
  isAuthErrorCode,
  isAuthInfoCode,
  AUTH_ERROR_CODES,
  AUTH_FALLBACK_MESSAGE,
  SERVER_INTERNAL_AUTH_ERROR_CODES,
} from "./authErrors.ts";
import { AUTH_ERRORS } from "../../app-api/auth/errors.ts";

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

/**
 * Google sign-in codes (issue #209, PR 6). These arrive as `?error=<CODE>` on a
 * 302 back to `/auth` — a browser redirect carries no JSON body — and render
 * through the SAME code→copy map the magic-link callback already uses. Copy is
 * verbatim from the §5.16 rows in `SPEC.amendments.md` (S5-1).
 *
 * `SAMO-AUTH-005` stays UNMAPPED on purpose: it is a server-side "session
 * outlived its tenant" 401 that clears the cookie, never a `?error=` value on the
 * sign-in page. Adding 006–010 must not quietly add 005.
 */
describe("authErrorMessage — exact §5.16 copy for the Google codes (#209)", () => {
  it("maps SAMO-AUTH-006 to the exact user-facing string (cancelled at Google)", () => {
    expect(authErrorMessage("SAMO-AUTH-006")).toBe(
      "Sign-in cancelled. Choose a way to sign in below.",
    );
  });

  it("maps SAMO-AUTH-007 to the exact user-facing string (em dash)", () => {
    expect(authErrorMessage("SAMO-AUTH-007")).toBe(
      "That sign-in attempt expired — please try again.",
    );
  });

  it("maps SAMO-AUTH-008 to the exact user-facing string", () => {
    expect(authErrorMessage("SAMO-AUTH-008")).toBe(
      "Google couldn't sign you in right now.",
    );
  });

  it("maps SAMO-AUTH-009 to the exact user-facing string", () => {
    expect(authErrorMessage("SAMO-AUTH-009")).toBe(
      "Your Google account's email isn't verified.",
    );
  });

  it("maps SAMO-AUTH-010 to the exact user-facing string", () => {
    expect(authErrorMessage("SAMO-AUTH-010")).toBe(
      "Google sign-in isn't available here.",
    );
  });

  it("recognizes 006–010 and still rejects 005 and 011", () => {
    expect(isAuthErrorCode("SAMO-AUTH-006")).toBe(true);
    expect(isAuthErrorCode("SAMO-AUTH-007")).toBe(true);
    expect(isAuthErrorCode("SAMO-AUTH-008")).toBe(true);
    expect(isAuthErrorCode("SAMO-AUTH-009")).toBe(true);
    expect(isAuthErrorCode("SAMO-AUTH-010")).toBe(true);
    expect(isAuthErrorCode("SAMO-AUTH-005")).toBe(false);
    expect(isAuthErrorCode("SAMO-AUTH-011")).toBe(false);
  });

  it("marks ONLY SAMO-AUTH-006 as info tone, not an error (§5.16 S5-1)", () => {
    expect(isAuthInfoCode("SAMO-AUTH-006")).toBe(true);
    expect(isAuthInfoCode("SAMO-AUTH-007")).toBe(false);
    expect(isAuthInfoCode("SAMO-AUTH-008")).toBe(false);
    expect(isAuthInfoCode("SAMO-AUTH-009")).toBe(false);
    expect(isAuthInfoCode("SAMO-AUTH-010")).toBe(false);
    expect(isAuthInfoCode("SAMO-AUTH-001")).toBe(false);
    expect(isAuthInfoCode("SAMO-NOPE-999")).toBe(false);
  });
});

/**
 * `SAMO-AUTH-500` — the retryable, OUR-FAULT infra failure (#219, follow-up to
 * the samorev review of #218).
 *
 * It has TWO delivery shapes. The magic-link callback delivers it as a 500 with
 * a JSON body (`apps/app-api/auth/service.ts`), and `MagicLinkCallback.tsx`
 * branches on `status` to show `AUTH_INFRA_MESSAGE`. PR #218 gave it a SECOND
 * shape — `302 → /auth?error=SAMO-AUTH-500`, from Google's token endpoint
 * answering 5xx (`google-oauth.ts`) and from the identity-provisioning catch
 * (`google-service.ts`) — and there `status` is 302 for every outcome, so the
 * ONLY thing carrying the meaning is the code. Without a row here the user is
 * told "Couldn't sign you in. Request a new link." — about a link they never
 * used, for a failure that is entirely ours.
 *
 * Copy is asserted as a LITERAL, not through `AUTH_INFRA_MESSAGE`: a constant
 * the fix could also edit cannot pin a string.
 */
describe("authErrorMessage — SAMO-AUTH-500, the infra failure (#219)", () => {
  it("maps SAMO-AUTH-500 to the exact §5.16 infra string (em dash)", () => {
    expect(authErrorMessage("SAMO-AUTH-500")).toBe(
      "Something went wrong on our end — please try again.",
    );
  });

  it("recognizes SAMO-AUTH-500 as a mapped code", () => {
    expect(isAuthErrorCode("SAMO-AUTH-500")).toBe(true);
  });

  it("never collapses SAMO-AUTH-500 back into the generic fallback", () => {
    expect(authErrorMessage("SAMO-AUTH-500")).not.toBe(AUTH_FALLBACK_MESSAGE);
  });

  it("keeps SAMO-AUTH-500 an ERROR tone, not the info tone", () => {
    expect(isAuthInfoCode("SAMO-AUTH-500")).toBe(false);
  });
});

/**
 * The invariant that makes #219 unrepeatable.
 *
 * The root cause was never the missing row — it was that `AuthErrorCode` was
 * declared TWICE, in `apps/app-api/auth/types.ts` and here, with no link between
 * them, so `tsc --noEmit` stayed green while the server redirected to a code the
 * web could not render.
 *
 * The invariant is NOT "the two unions are equal". Some codes are genuinely
 * server-internal and never reach the browser as a renderable code:
 * `SAMO-AUTH-005` is a 401 + clear-cookie for a session that outlived its tenant
 * (#114, §5.14) — the browser is redirected to sign-in, never handed the code.
 * The true invariant is: EVERY app-api auth code that is not on the explicit,
 * documented server-internal list has a copy row here. The list is asserted
 * literally below, so growing it is a deliberate, reviewable act — not a way to
 * silence this test.
 */
describe("web copy map vs the app-api §5.16 reference (#219)", () => {
  it("covers every app-api auth code except the documented server-internal ones", () => {
    const internal = SERVER_INTERNAL_AUTH_ERROR_CODES as readonly string[];
    const deliverable = Object.keys(AUTH_ERRORS)
      .filter((code) => !internal.includes(code))
      .sort();
    expect([...(AUTH_ERROR_CODES as readonly string[])].sort()).toEqual(deliverable);
  });

  it("SAMO-AUTH-005 is the ONLY server-internal exclusion, and stays unmapped", () => {
    expect([...SERVER_INTERNAL_AUTH_ERROR_CODES]).toEqual(["SAMO-AUTH-005"]);
    // …and it is a REAL app-api code, so the `Exclude<>` in `authErrors.ts`
    // subtracts something that exists rather than silently doing nothing.
    for (const code of SERVER_INTERNAL_AUTH_ERROR_CODES) {
      expect(Object.keys(AUTH_ERRORS)).toContain(code);
    }
    expect(isAuthErrorCode("SAMO-AUTH-005")).toBe(false);
    expect(authErrorMessage("SAMO-AUTH-005")).toBe(AUTH_FALLBACK_MESSAGE);
  });

  it("renders copy byte-identical to the app-api's own §5.16 message", () => {
    for (const code of AUTH_ERROR_CODES) {
      expect(authErrorMessage(code)).toBe(AUTH_ERRORS[code].message);
    }
  });
});
