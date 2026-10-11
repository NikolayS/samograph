/**
 * Programmatic runner for the SUPERUSER DB bootstrap (`bootstrap.sql`, #186).
 *
 * Mirrors `migrate.ts`, but with the opposite privilege contract: it takes a
 * SUPERUSER connection and the env-specific app LOGIN role, and wires the two
 * grants the runtime path needs (membership + BYPASSRLS). It is NOT a migration —
 * the migrate path connects as the non-superuser login role and cannot run these
 * statements. Deploy order per env: run THIS as superuser, THEN `migrate` as the
 * login role.
 *
 * `bootstrap.sql` is the single source of truth; this runner just substitutes the
 * psql `:"app_login_role"` variable (Bun's `SQL` does not speak psql `-v`) and
 * executes it. The role name is validated as a bare SQL identifier before it is
 * ever interpolated, so there is no injection surface.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

/** Absolute path to the superuser bootstrap script this runner executes. */
export const BOOTSTRAP_SQL_PATH = join(import.meta.dir, "bootstrap.sql");

/** A bare (unquoted) SQL identifier: a role name safe to interpolate as-is. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Reject anything that is not a plain SQL identifier before it reaches the SQL
 * string. Role names we control ("samo", "samograph") always pass; this closes
 * the interpolation hole psql `-v` would otherwise leave.
 */
export function assertRoleName(role: string): void {
  if (!IDENTIFIER.test(role) || role.length > 63) {
    throw new Error(`invalid app login role name: ${JSON.stringify(role)}`);
  }
}

/** Render `bootstrap.sql` with the psql `:"app_login_role"` variable substituted. */
export function renderBootstrapSql(appLoginRole: string): string {
  assertRoleName(appLoginRole);
  const ident = `"${appLoginRole}"`; // validated: no embedded quotes possible
  const literal = `'${appLoginRole}'`;
  return readFileSync(BOOTSTRAP_SQL_PATH, "utf8")
    .replaceAll(':"app_login_role"', ident)
    .replaceAll(":'app_login_role'", literal);
}

/**
 * Apply the bootstrap for `appLoginRole` over a SUPERUSER connection. Idempotent:
 * safe to run on every deploy / fresh DBLab preview clone.
 */
export async function applyBootstrap(sql: SQL, appLoginRole: string): Promise<void> {
  await sql.unsafe(renderBootstrapSql(appLoginRole));
}

if (import.meta.main) {
  const superuserDsn = process.env.SUPERUSER_DATABASE_URL ?? process.env.DATABASE_URL;
  const appLoginRole = process.argv[2] ?? process.env.APP_LOGIN_ROLE;
  if (!superuserDsn) {
    console.error("SUPERUSER_DATABASE_URL (or DATABASE_URL) is required");
    process.exit(1);
  }
  if (!appLoginRole) {
    console.error("app login role required: `bun bootstrap.ts <role>` (or APP_LOGIN_ROLE)");
    process.exit(1);
  }
  const sql = new SQL(superuserDsn);
  try {
    await applyBootstrap(sql, appLoginRole);
    console.log(`bootstrap applied for app login role: ${appLoginRole}`);
  } finally {
    await sql.close();
  }
}
