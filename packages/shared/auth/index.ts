/**
 * `@samograph/shared/auth` — the tenant-isolation authorization gate (SPEC §5.6).
 *
 * A SINGLE entry point, {@link authorizeCall}, is the only way to authorize
 * access to a call: session cookie → `read` (session-derived, never persisted),
 * share token → `share` (persisted, revocable, via the #52 verifier), and the
 * v2 `act:*` agent-token seam. It sets the Postgres tenant context so RLS engages
 * and fails closed to a single bodyless 403 (`SAMO-AUTHZ-001`). See §5.6/§5.7/§6.2 #4.
 */
export {
  authorizeCall,
  AUTHZ_ERROR_CODE,
  DENY,
  type AuthorizeDeps,
  type AuthorizeRequest,
  type AuthorizeResult,
  type Scope,
  type Session,
} from "./gate.ts";
