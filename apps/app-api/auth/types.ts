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
  | "SAMO-AUTH-003" // already used (replay)
  | "SAMO-AUTH-004" // rate limit (5/hr email OR 20/hr IP)
  | "SAMO-AUTH-005"; // stale session — the tenant no longer exists (#114, §5.14)

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
