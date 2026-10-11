/**
 * Tiny, dependency-free migration runner for the samograph.dev Postgres schema.
 *
 * Migrations are plain `.sql` files in `./migrations`, applied in lexical order.
 * Applied versions are recorded in `schema_migrations` (same table the CI
 * Postgres smoke uses), so re-running is a no-op — migrations are idempotent on
 * a fresh DB (SPEC §6.1: real migrations against the ephemeral container, no
 * mocks). Each file runs inside its own transaction; a failure rolls back that
 * migration and leaves `schema_migrations` untouched.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

/** Absolute path to the directory holding the ordered `NNNN_*.sql` migrations. */
export const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/** Lexically-ordered migration versions (filenames without the `.sql` suffix). */
export function migrationVersions(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => name.replace(/\.sql$/, ""));
}

const ENSURE_LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

export interface MigrateResult {
  /** Versions applied by THIS run (empty when already up to date). */
  applied: string[];
}

/**
 * Apply every pending migration in order. Returns the versions applied by this
 * run; running again with no new files returns `{ applied: [] }`.
 */
export async function migrate(sql: SQL): Promise<MigrateResult> {
  await sql.unsafe(ENSURE_LEDGER);
  const recorded = new Set(
    (await sql`SELECT version FROM schema_migrations`).map(
      (row: { version: string }) => row.version,
    ),
  );

  const applied: string[] = [];
  for (const version of migrationVersions()) {
    if (recorded.has(version)) continue;
    const ddl = readFileSync(join(MIGRATIONS_DIR, `${version}.sql`), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
    });
    applied.push(version);
  }
  return { applied };
}

if (import.meta.main) {
  const { connect } = await import("./client.ts");
  const sql = connect();
  try {
    const { applied } = await migrate(sql);
    console.log(
      applied.length ? `applied: ${applied.join(", ")}` : "up to date",
    );
  } finally {
    await sql.close();
  }
}
