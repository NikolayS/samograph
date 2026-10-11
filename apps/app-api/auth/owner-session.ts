/**
 * Shared owner-session resolution for tenant-scoped routes (SPEC §5.1, §5.14; #114/#159).
 *
 * A session cookie is a stateless HMAC ({@link verifySession}), so it OUTLIVES
 * its tenant: prod deletes/erases the tenant on §5.14 account deletion, dev
 * recreates the DB. This module funnels every tenant-scoped route (the `/calls`
 * surface AND `DELETE /account`) through ONE resolve so a cookie whose tenant is
 * gone — or whose account has been ERASED — is rejected with a 401 clear-cookie
 * instead of a silent-empty read or an uncaught FK 500.
 *
 * The check runs on the PRIVILEGED (login-role, `BYPASSRLS`) connection — NOT
 * inside a `SET LOCAL ROLE samograph_app` tx — because auth runs before any
 * tenant context exists and `tenants` carries no tenant context of its own.
 */
import type { SQL } from "bun";
import {
  verifySession,
  buildClearedSessionCookie,
  type SessionClaims,
} from "./session.ts";
import { AUTH_ERRORS } from "./errors.ts";

/**
 * The `audit_log.action` written as the durable ACCOUNT-erasure tombstone
 * (§5.14). Its mere presence for a tenant means the account was deleted — the
 * signal {@link tenantActive} reads to revoke every stateless session cookie
 * without a server-side session store.
 */
export const ACCOUNT_DELETED_ACTION = "account_deleted" as const;

/** §5.16 code for a stale session whose tenant no longer exists / was erased (#114). */
const SESSION_INVALID_CODE = "SAMO-AUTH-005" as const;

/**
 * The 401 for a session whose tenant no longer exists or whose account was erased
 * (#114, §5.14). Carries the stable `SAMO-AUTH-005` code so the web renders a
 * distinct "you've been signed out" copy (not the generic "Request failed."), and
 * CLEARS the cookie with the exact attributes {@link buildClearedSessionCookie}
 * sets, so the browser drops the cookie and the dashboard redirects to sign-in.
 */
export function sessionInvalidResponse(): Response {
  const info = AUTH_ERRORS[SESSION_INVALID_CODE];
  return new Response(
    JSON.stringify({ code: info.code, message: info.message, retryable: info.retryable }),
    {
      status: info.httpStatus,
      headers: {
        "content-type": "application/json",
        "set-cookie": buildClearedSessionCookie(),
      },
    },
  );
}

/**
 * Is the tenant ACTIVE? True iff its `tenants` row exists AND it carries NO
 * {@link ACCOUNT_DELETED_ACTION} tombstone. A deleted-account tenant keeps its
 * row + tombstone as the durable erasure record (§5.14), so existence alone is
 * not enough — the tombstone revokes the account's sessions.
 *
 * Runs on the PRIVILEGED `sql` connection (login role bypasses RLS), like the
 * pre-tenant auth reads.
 */
export async function tenantActive(sql: SQL, tenantId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS ok
    FROM tenants t
    WHERE t.id = ${tenantId}
      AND NOT EXISTS (
        SELECT 1 FROM audit_log a
        WHERE a.tenant_id = t.id AND a.action = ${ACCOUNT_DELETED_ACTION}
      )`) as unknown as unknown[];
  return rows.length > 0;
}

/** The outcome of resolving an owner session cookie against the current DB. */
export type OwnerSession =
  | { kind: "ok"; claims: SessionClaims } // valid signature AND the tenant is active
  | { kind: "stale" } // valid signature but the tenant was deleted/erased → 401 clear-cookie
  | { kind: "anonymous" }; // missing / tampered / expired → the route's 401/403

/**
 * The SHARED owner-session resolve every tenant-scoped route funnels through:
 * verify the HMAC cookie (no DB), then confirm its tenant is still ACTIVE. This
 * turns a deleted/erased-tenant cookie into a 401 instead of a silent-empty read
 * or an uncaught FK 500 (#114, §5.14).
 */
export async function resolveOwnerSession(
  sql: SQL,
  sessionSecret: string,
  cookie: string | null,
  nowMs: number,
): Promise<OwnerSession> {
  const claims = cookie ? verifySession(cookie, sessionSecret, nowMs) : null;
  if (!claims) return { kind: "anonymous" };
  if (!(await tenantActive(sql, claims.tenantId))) return { kind: "stale" };
  return { kind: "ok", claims };
}
