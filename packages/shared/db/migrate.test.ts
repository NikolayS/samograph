/**
 * Migration-runner integration tests — run against the CI ephemeral Postgres
 * (real migrations, no mocks; SPEC §6.1). Skipped when DATABASE_URL is unset so
 * the mock-free DB suite only runs on the Postgres-backed CI job.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect } from "./client.ts";
import { migrate, migrationVersions } from "./migrate.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("db migrations (§5.10)", () => {
  let sql: ReturnType<typeof connect>;

  beforeAll(() => {
    sql = connect();
  });
  afterAll(async () => {
    await sql.close();
  });

  it("apply cleanly on a fresh DB and are idempotent (exact applied set)", async () => {
    // Fresh DB: drop everything our migrations create, then migrate from zero.
    await sql.unsafe(`
      DROP TABLE IF EXISTS
        webhook_events, transcripts, tokens, workers, audit_log, calls, tenants, users, regions, schema_migrations
      CASCADE;
      DROP TYPE IF EXISTS call_status CASCADE;
      DROP FUNCTION IF EXISTS reset_ingest_degraded_on_terminal() CASCADE;
    `);

    const versions = migrationVersions();
    expect(versions.length).toBeGreaterThan(0);

    // First run applies every migration, in order.
    const first = await migrate(sql);
    expect(first.applied).toEqual(versions);

    const recorded = (
      await sql`SELECT version FROM schema_migrations ORDER BY version`
    ).map((r: { version: string }) => r.version);
    expect(recorded).toEqual(versions);

    // Second run is a pure no-op: nothing re-applied (idempotent).
    const second = await migrate(sql);
    expect(second.applied).toEqual([]);
  });

  it("create exactly the §5.10 tables", async () => {
    await migrate(sql);
    const expected = [
      "audit_log",
      "calls",
      "regions",
      "tenants",
      "tokens",
      "transcripts",
      "users",
      "workers",
    ];
    const all = (
      await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    ).map((r: { tablename: string }) => r.tablename);
    expect(expected.filter((t) => all.includes(t))).toEqual(expected);
  });

  it("define call_status with exactly the §5.2 enum values, in order", async () => {
    await migrate(sql);
    const rows = await sql`
      SELECT e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'call_status'
      ORDER BY e.enumsortorder`;
    expect(rows.map((r: { label: string }) => r.label)).toEqual([
      "PENDING",
      "JOINING",
      "IN_CALL",
      "ENDED",
      "COULD_NOT_JOIN",
      "COULD_NOT_RECORD",
      "BOT_REMOVED",
    ]);
  });

  it("model calls.ingest_degraded as a boolean overlay defaulting to false", async () => {
    await migrate(sql);
    const rows = await sql`
      SELECT data_type, column_default FROM information_schema.columns
      WHERE table_name = 'calls' AND column_name = 'ingest_degraded'`;
    expect(rows[0].data_type).toBe("boolean");
    expect(rows[0].column_default).toBe("false");
  });

  it("PK transcripts on (call_id, seq) — append-only", async () => {
    await migrate(sql);
    const rows = await sql`
      SELECT a.attname AS col
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'transcripts'::regclass AND i.indisprimary
      ORDER BY a.attnum`;
    expect(rows.map((r: { col: string }) => r.col)).toEqual(["call_id", "seq"]);
  });
});
