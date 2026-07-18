/**
 * `@samograph/shared/db` — Postgres schema, migration runner, and the
 * tenant-context primitive for the multi-tenant RLS data layer (SPEC §5.10).
 */
export { connect, databaseUrl, setTenant } from "./client.ts";
export {
  MIGRATIONS_DIR,
  migrate,
  migrationVersions,
  type MigrateResult,
} from "./migrate.ts";
export {
  BOOTSTRAP_SQL_PATH,
  applyBootstrap,
  assertRoleName,
  renderBootstrapSql,
} from "./bootstrap.ts";
