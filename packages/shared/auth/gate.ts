/**
 * The tenant-isolation authorization gate (SPEC §5.6) — the security hinge.
 *
 * `authorizeCall` is the ONE entry point every authenticated route, every WS
 * upgrade, and every bot-worker invocation calls before touching state. No code
 * path may reach a call / Recall without passing through it. It turns the inbound
 * credentials on a request into a concrete `{ tenantId, callId, scopes }` grant —
 * or a single, bodyless 403 denial.
 *
 * Two credential paths in v1, plus a v2 seam — all converging on the same result:
 *
 *   • session cookie → `read` — DERIVED from the owner's session (§5.7). There is
 *     NO `tokens` row for `read`; the gate confirms the requested `call_id` lives
 *     in the session's tenant purely through RLS, and "revocation" is sign-out /
 *     session expiry. (Session ISSUANCE is #42; this gate only CONSUMES a session
 *     via the injected {@link AuthorizeDeps.lookupSession} seam.)
 *   • share token → `share` — PERSISTED & revocable, verified through the #52
 *     verifier ({@link verifyToken}). The gate adds an explicit call-binding check
 *     (the token's `call_id` must equal the requested `call_id`), backstopped by
 *     RLS scoping the `tokens` read to the call's tenant.
 *   • [v2 stub] agent token → `act:*` — the SAME verifier already supports these
 *     persisted scopes; the gate routes them through the identical token path. v1
 *     never mints them, but the seam authorizes them with zero extra wiring.
 *
 * On success the gate establishes the Postgres tenant context with #50's
 * {@link setTenant} (`set_config('app.tenant_id', …, true)`) on the request's
 * transaction, so every subsequent query in that transaction is RLS-scoped.
 *
 * Fail-closed: EVERY failure mode — and any unexpected error (bad-uuid 22P02, a
 * DB outage, a verifier throw) — returns exactly {@link DENY} (403, no body,
 * `SAMO-AUTHZ-001`, §5.16). There is deliberately no verifier-side cache (§5.5),
 * so a revoke takes effect on the very next call (the ≤ 1 s SLO, §6.2 #4).
 *
 * The two privileged, pre-tenant lookups (session, call→tenant) are injected as
 * seams: in production they run on a privileged connection BEFORE any tenant
 * context exists (mirroring how auth reads `users` before tenancy — §5.10); the
 * RLS-scoped work (token verify, call-membership) runs on the request's `tx`.
 */
import type { SQL } from "bun";
import { setTenant } from "../db/client.ts";
import { verifyToken } from "../tokens/store.ts";
import type { Keyring } from "../tokens/signing.ts";

/** Stable error code for a tenancy-gate denial (SPEC §5.16). */
export const AUTHZ_ERROR_CODE = "SAMO-AUTHZ-001" as const;

/** The v1 scopes the gate can grant, plus the v2 `act:*` seam (§5.7). */
export type Scope = "read" | "share" | "act:chat" | "act:frame" | "act:presence" | "act:leave";

/** The credentials carried by an inbound request. The gate authorizes `callId`. */
export interface AuthorizeRequest {
  /** The call being accessed — the resource the gate authorizes against. */
  callId: string;
  /** Owner session cookie (consumed here, never minted — issuance is #42). */
  sessionCookie?: string | null;
  /** Persisted `share` capability token (§5.7). */
  shareToken?: string | null;
  /** [v2 stub] persisted `act:*` agent token — same wire path, unminted in v1. */
  agentToken?: string | null;
}

/** The resolved owner session (produced by the #42 seam, consumed here). */
export interface Session {
  userId: string;
  tenantId: string;
}

/** Injected collaborators: the keyring + the two privileged, pre-tenant lookups. */
export interface AuthorizeDeps {
  /** Token-verification keyring (current + previous KID; §5.7 rotation overlap). */
  keyring: Keyring;
  /** #42 seam: resolve an opaque session cookie → session (privileged, pre-tenant). */
  lookupSession: (cookie: string) => Promise<Session | null>;
  /** Privileged (pre-tenant) call→tenant resolver; `null` when the call is unknown. */
  lookupCallTenant: (callId: string) => Promise<string | null>;
  /** Epoch seconds; defaults to the wall clock. Tests pin it for expiry cases. */
  now?: number;
}

/** Success carries the grant; failure is always the single bodyless 403. */
export type AuthorizeResult =
  | { authorized: true; tenantId: string; callId: string; scopes: Scope[] }
  | { authorized: false; status: 403; code: typeof AUTHZ_ERROR_CODE };

/**
 * The ONE denial value — 403, no body (§5.6). Frozen so every failure path
 * returns an identical, immutable result the HTTP layer renders as an empty 403.
 */
export const DENY: AuthorizeResult = Object.freeze({
  authorized: false,
  status: 403,
  code: AUTHZ_ERROR_CODE,
});

// =============================================================================
// PERMISSIVE STUB (RED) — authorizes on mere credential PRESENCE, skipping every
// isolation check (call∈tenant, binding, expiry, revocation, persistence). It
// exists ONLY to capture the RED adversarial failures; the GREEN commit replaces
// this body with the real gate. DO NOT SHIP.
// =============================================================================
export async function authorizeCall(
  tx: SQL,
  req: AuthorizeRequest,
  deps: AuthorizeDeps,
): Promise<AuthorizeResult> {
  if (typeof req.sessionCookie === "string" && req.sessionCookie.length > 0) {
    const session = await deps.lookupSession(req.sessionCookie);
    if (session) {
      await setTenant(tx, session.tenantId);
      return { authorized: true, tenantId: session.tenantId, callId: req.callId, scopes: ["read"] };
    }
  }
  const token = req.shareToken ?? req.agentToken;
  if (typeof token === "string" && token.length > 0) {
    const tenantId =
      (await deps.lookupCallTenant(req.callId)) ?? "00000000-0000-0000-0000-000000000000";
    await setTenant(tx, tenantId);
    return {
      authorized: true,
      tenantId,
      callId: req.callId,
      scopes: req.agentToken ? ["act:chat"] : ["share"],
    };
  }
  return DENY;
}
