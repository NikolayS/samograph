/**
 * Shared types for the magic-link auth subsystem (SPEC §5.1, §5.16, §6.2 #6).
 *
 * Magic-link auth is the ONLY v1 authentication path. Every subtle security
 * behaviour (single-use, 15-min TTL, supersession, constant-time verify,
 * independent rate limits) is TDD'd against in-memory fakes so the suite runs
 * with no network (the real EmailSender provider is chosen in Sprint 3, and the
 * stores are swappable for a Postgres/Redis-backed impl later).
 */

/** Monotonic-ish wall clock injected everywhere time matters, in epoch ms. */
export type Clock = () => number;

/** Stable, switchable error codes from the §5.16 reference. */
export type AuthErrorCode =
  | "SAMO-AUTH-001" // invalid / tampered KID / bad signature
  | "SAMO-AUTH-002" // expired (> 15 min)
  | "SAMO-AUTH-003" // already used (replay) or superseded by a newer link
  | "SAMO-AUTH-004" // rate limit (5/hr email OR 20/hr IP)
  | "SAMO-AUTH-005" // stale session — the tenant no longer exists (#114, §5.14)
  // ── Google sign-in, issue #209 / SPEC amendment S5-1 §5.16 ────────────────
  // These five are delivered as a `302 → /auth?error=<CODE>` (a browser redirect
  // carries no JSON body), which is why their `httpStatus` in `errors.ts` is 302
  // rather than a 4xx. None of them distinguishes "this email exists in our DB"
  // from "it does not": the split is "your browser/tab went stale" vs "Google's
  // side failed" vs "your own Google email is unverified".
  | "SAMO-AUTH-006" // user cancelled at Google's consent screen (`error=access_denied`)
  | "SAMO-AUTH-007" // OAuth state / PKCE / nonce failure — missing, tampered, expired or mismatched
  | "SAMO-AUTH-008" // Google-side or ID-token failure (exchange, JWKS, signature, iss/aud/exp/nonce)
  | "SAMO-AUTH-009" // `email_verified` is not boolean `true` on the verified ID token
  | "SAMO-AUTH-010" // Google sign-in is not configured on this deployment (branch previews)
  | "SAMO-AUTH-500" // our fault — provisioning/infra failure; link stays retryable (#180)
  | "SAMO-CALENDAR-001" | "SAMO-CALENDAR-002" | "SAMO-CALENDAR-003"
  | "SAMO-CALENDAR-004" | "SAMO-CALENDAR-005" | "SAMO-CALENDAR-006"
  | "SAMO-CALENDAR-500";

/**
 * How an account was CREATED — persisted as `users.signup_method` (migration
 * 0012) and surfaced as the `method` label on the §5.11 activation funnel
 * (SPEC amendment S5-1 item 7; issue #222).
 *
 * This module is the DOMAIN OWNER of the list: the migration's CHECK and the
 * metric-label mirror in `packages/shared/observe/funnel.ts` both follow it
 * (`stores.test.ts` pins the two lists together at compile time). It records
 * creation and never the last sign-in, so linking a second credential to an
 * existing account leaves it untouched.
 */
export const SIGNUP_METHODS = ["magic_link", "google"] as const;

export type SignupMethod = (typeof SIGNUP_METHODS)[number];

/**
 * The method assumed when a caller does not say — and the DDL default migration
 * 0012 stamps on every row that predates it. Both have to be the same string:
 * every account created before Google sign-in existed was a magic-link signup.
 */
export const DEFAULT_SIGNUP_METHOD: SignupMethod = "magic_link";

/** A signed-in principal: a user and their 1:1 tenant (SPEC §5.1, §5.10). */
export interface AuthUser {
  id: string;
  email: string;
  tenantId: string;
}

/** Lifecycle of one outstanding magic link, tracked server-side. */
export type MagicLinkStatus = "outstanding" | "consumed" | "superseded";

/** Server-side record of an issued magic link (the token's secret is NOT here). */
export interface MagicLinkRecord {
  jti: string;
  email: string;
  kid: string;
  issuedAt: number;
  expiresAt: number;
  status: MagicLinkStatus;
}
