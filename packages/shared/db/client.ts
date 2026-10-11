/**
 * Postgres connection + tenant-context helpers for the samograph.dev backend.
 *
 * A single multi-tenant Postgres with Row-Level Security is the data foundation
 * for every backend deliverable (SPEC §5.10). This module is intentionally
 * tiny: open a connection, and provide the ONE primitive that establishes the
 * tenant context every RLS policy reads. The tenancy gate (`authorizeCall`,
 * §5.6 / issue #41) is the only production caller of {@link setTenant}; this
 * issue only ships the primitive + the policies it drives.
 */
import { SQL } from "bun";

/** Resolve the Postgres connection string, throwing if it is not configured. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return url;
}

/** Open a new Postgres connection pool against `DATABASE_URL` (or `url`). */
export function connect(url: string = databaseUrl()): SQL {
  return new SQL(url);
}

/**
 * Set the **transaction-local** tenant context (`app.tenant_id`) that every RLS
 * policy reads via the InitPlan wrapper `(SELECT current_setting('app.tenant_id'))::uuid`
 * (SPEC §5.10). `is_local = true` scopes it to the current transaction, so it
 * never leaks across pooled connections. MUST be called inside a transaction
 * (e.g. the callback of `sql.begin(...)`).
 */
export async function setTenant(tx: SQL, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}
