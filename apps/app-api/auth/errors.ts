/**
 * The SAMO-AUTH error reference (SPEC §5.16). Codes are stable and safe to
 * switch on. The /auth/callback endpoint deliberately returns 401 with NO body
 * on every failure (no information leak about which check failed); the code is
 * carried internally for logging. /auth/magic-link surfaces SAMO-AUTH-004 (429)
 * with a Retry-After header.
 */
import type { AuthErrorCode } from "./types.ts";

export interface AuthErrorInfo {
  code: AuthErrorCode;
  httpStatus: number;
  /** Plain-English, user-facing copy (§5.16). */
  message: string;
  retryable: boolean;
}

export const AUTH_ERRORS: Record<AuthErrorCode, AuthErrorInfo> = {
  "SAMO-AUTH-001": {
    code: "SAMO-AUTH-001",
    httpStatus: 401,
    message: "This sign-in link isn't valid.",
    retryable: false,
  },
  "SAMO-AUTH-002": {
    code: "SAMO-AUTH-002",
    httpStatus: 401,
    message: "This sign-in link has expired.",
    retryable: false,
  },
  "SAMO-AUTH-003": {
    code: "SAMO-AUTH-003",
    httpStatus: 401,
    message: "This link was already used.",
    retryable: false,
  },
  "SAMO-AUTH-004": {
    code: "SAMO-AUTH-004",
    httpStatus: 429,
    message: "Too many sign-in attempts — try again shortly.",
    retryable: true,
  },
  // A stateless HMAC session cookie can outlive its tenant (prod: §5.14 GDPR
  // tenant deletion; dev: the Postgres was recreated). The signature still
  // verifies but the tenant row is gone, so tenant-scoped routes force re-auth:
  // 401 + clear-cookie so the browser drops the cookie and the web redirects to
  // sign-in, instead of reading empty (GET) or a raw FK 500 (POST) — see #114.
  "SAMO-AUTH-005": {
    code: "SAMO-AUTH-005",
    httpStatus: 401,
    message: "You've been signed out. Please sign in again.",
    retryable: false,
  },
  // ── Google sign-in (issue #209, SPEC amendment S5-1 §5.16) ────────────────
  //
  // WHY `httpStatus` IS 302 ON ALL FIVE. Every one of these is decided while the
  // browser is mid-redirect between us and accounts.google.com. There is no
  // fetch to answer with JSON and no page of ours rendering yet, so the delivery
  // mechanism is `302 Location: /auth?error=<CODE>` and the sign-in page renders
  // the copy below from the SAME code→copy map (`apps/web/lib/authErrors.ts`).
  // Recording a 4xx here would be recording a status we never send. S5-1
  // deliberately left this number for the implementing PR to pin; this is it.
  //
  // The `message` strings are byte-identical to `apps/web/lib/authErrors.ts` and
  // are asserted verbatim on both sides — they are a contract, not copy.
  //
  // NOTE: `SAMO-AUTH-004` (above) is REUSED for the two Google rate-limit
  // buckets rather than given a Google-specific twin, and `SAMO-AUTH-500` (below)
  // for retryable infra failure, so those semantics stay in one place.

  // The user pressed "Cancel" on Google's consent screen. Not a failure — they
  // did exactly what they meant to — so the web renders it in an INFO tone
  // (`role="status"`, not `role="alert"`). `retryable` because the remedy is
  // simply "choose a way to sign in", not "wait for us to fix something".
  "SAMO-AUTH-006": {
    code: "SAMO-AUTH-006",
    httpStatus: 302,
    message: "Sign-in cancelled. Choose a way to sign in below.",
    retryable: true,
  },
  // The `__Host-samo_oauth` state cookie was missing, tampered with, carried the
  // wrong `v`, aged past its 10-minute TTL, or its `state` did not match the one
  // Google echoed. All four collapse into ONE code on purpose: the sub-reasons
  // are indistinguishable to the user (and distinguishing them would tell an
  // attacker which of our checks he tripped), and the action is identical —
  // start again. The overwhelmingly common cause is a stale tab.
  "SAMO-AUTH-007": {
    code: "SAMO-AUTH-007",
    httpStatus: 302,
    message: "That sign-in attempt expired — please try again.",
    retryable: true,
  },
  // Google refused the token exchange, or the ID token failed local verification
  // (signature, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, `sub`, `email`).
  // Google's own `error` / `error_description` is NEVER reflected into this
  // message, the redirect URL, or a rendered log: its token endpoint echoes our
  // request parameters back, so reading it only creates something to leak.
  "SAMO-AUTH-008": {
    code: "SAMO-AUTH-008",
    httpStatus: 302,
    message: "Google couldn't sign you in right now.",
    retryable: true,
  },
  // `email_verified` is not boolean `true` on the VERIFIED ID token (false,
  // absent, the string "true", the number 1). This is the hard gate that stands
  // between the callback and an account takeover: `users.email` is UNIQUE and
  // `createOrLoadUser` upserts on it, so proceeding would let anyone who can
  // assert an unverified address walk into an existing user's tenant. On this
  // code we create nothing, link nothing and mint no cookie. NOT retryable:
  // clicking again changes nothing until Google verifies the address.
  "SAMO-AUTH-009": {
    code: "SAMO-AUTH-009",
    httpStatus: 302,
    message: "Your Google account's email isn't verified.",
    retryable: false,
  },
  // No Google credentials are configured for this environment — the normal,
  // designed state of every branch preview (Google exact-matches redirect URIs
  // with no wildcards, so an unbounded set of preview hostnames can never be
  // registered). NOT retryable: magic link is the credential here, and
  // `GET /auth/providers` already reports `{"google":false}` so the button that
  // leads here should never have rendered.
  "SAMO-AUTH-010": {
    code: "SAMO-AUTH-010",
    httpStatus: 302,
    message: "Google sign-in isn't available here.",
    retryable: false,
  },
  // An infra/provisioning failure AFTER a valid link verified (e.g. the pre-tenant
  // bootstrap `INSERT INTO tenants` hits a DB/RLS error — #180). The callback maps
  // it to a 500 with this code instead of an unhandled throw, and — crucially —
  // the single-use link is left OUTSTANDING (provision runs BEFORE consume), so
  // the user can simply click again once we recover. Retryable: our fault.
  "SAMO-AUTH-500": {
    code: "SAMO-AUTH-500",
    httpStatus: 500,
    message: "Something went wrong on our end — please try again.",
    retryable: true,
  },
  "SAMO-CALENDAR-001": { code: "SAMO-CALENDAR-001", httpStatus: 503, message: "Google Calendar isn’t available here.", retryable: false },
  "SAMO-CALENDAR-002": { code: "SAMO-CALENDAR-002", httpStatus: 302, message: "Google Calendar wasn’t connected.", retryable: true },
  "SAMO-CALENDAR-003": { code: "SAMO-CALENDAR-003", httpStatus: 302, message: "That Google Calendar connection expired. Please try again.", retryable: true },
  "SAMO-CALENDAR-004": { code: "SAMO-CALENDAR-004", httpStatus: 302, message: "Google Calendar couldn’t be connected. Please try again.", retryable: true },
  "SAMO-CALENDAR-005": { code: "SAMO-CALENDAR-005", httpStatus: 409, message: "Google Calendar needs to be reconnected.", retryable: true },
  "SAMO-CALENDAR-006": { code: "SAMO-CALENDAR-006", httpStatus: 502, message: "Upcoming meetings couldn’t be refreshed. Please try again.", retryable: true },
  "SAMO-CALENDAR-500": { code: "SAMO-CALENDAR-500", httpStatus: 500, message: "Something went wrong connecting Google Calendar.", retryable: true },
};
