/**
 * Row-Level Security integration tests — the data-isolation contract of §5.10.
 *
 * Run against the CI ephemeral Postgres (real migrations + real RLS, no mocks;
 * SPEC §6.1), skipped when DATABASE_URL is unset. Fixtures are seeded as the
 * superuser (which bypasses RLS); isolation is then exercised as the NON-super
 * `samograph_app` role with a transaction-local `app.tenant_id`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, setTenant } from "./client.ts";
import { migrate } from "./migrate.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

// The tenant-scoped tables that MUST carry an RLS policy (§5.10). `users` and
// `regions` are not tenant-scoped and are intentionally excluded. `webhook_events`
// is tenant-scoped via its call's tenant (recall_bot_id join, 0003 / §5.3).
const TENANT_SCOPED = [
  "audit_log",
  "calls",
  "tenants",
  "tokens",
  "transcripts",
  "webhook_events",
  "workers",
];

// The MANDATORY InitPlan wrapper: `(SELECT current_setting('app.tenant_id'))`.
// Postgres deparses it as `( SELECT current_setting('app.tenant_id'::text) ...)`.
// A bare `current_setting('app.tenant_id')` (re-evaluated per row) would NOT
// contain the leading `SELECT` and must fail this match.
const INITPLAN_WRAPPER = /\(\s*SELECT\s+current_setting\('app\.tenant_id'/i;

d("RLS tenant isolation (§5.10)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID();
  const callB = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);

    // Seed two isolated tenants, each with one call + one transcript line.
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}),
      (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}),
      (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, ingest_degraded) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/a', 'IN_CALL', true),
      (${callB}, ${tenantB}, 'https://meet.google.com/b', 'IN_CALL', true)`;
    await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text) VALUES
      (${callA}, 1, now(), 'Alice', 'hello from A'),
      (${callB}, 1, now(), 'Bob',   'hello from B')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM calls WHERE id IN (${callA}, ${callB})`;
    await sql`DELETE FROM calls WHERE meeting_url = 'https://meet.google.com/evil'`;
    await sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  it("hides tenant B's calls from tenant A (cross-tenant SELECT = 0 rows)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantA);

      const mine = await tx`SELECT id FROM calls`;
      expect(mine.map((r: { id: string }) => r.id)).toEqual([callA]);

      const crossTenant = await tx`SELECT count(*)::int AS c FROM calls WHERE tenant_id = ${tenantB}`;
      expect(crossTenant[0].c).toBe(0);
    });
  });

  it("hides tenant B's transcripts from tenant A (filtered via call_id = 0 rows)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantA);

      const mine = await tx`SELECT text FROM transcripts`;
      expect(mine.map((r: { text: string }) => r.text)).toEqual(["hello from A"]);

      const crossTenant = await tx`SELECT count(*)::int AS c FROM transcripts WHERE call_id = ${callB}`;
      expect(crossTenant[0].c).toBe(0);
    });
  });

  it("rejects an INSERT mislabeled to another tenant (WITH CHECK, SQLSTATE 42501)", async () => {
    let caught: { errno?: string; message?: string } | null = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, tenantA);
        await tx`INSERT INTO calls (tenant_id, meeting_url, status)
                 VALUES (${tenantB}, 'https://meet.google.com/evil', 'PENDING')`;
      });
    } catch (err) {
      caught = err as { errno?: string; message?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.errno).toBe("42501");
    expect(caught?.message).toMatch(/row-level security policy/);
  });

  it("policies exist on exactly the tenant-scoped tables, each using the InitPlan wrapper", async () => {
    const policies = await sql`
      SELECT tablename, policyname, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename`;

    // Exactly one isolation policy per tenant-scoped table — no more, no less.
    expect(policies.map((p: { tablename: string }) => p.tablename)).toEqual(TENANT_SCOPED);

    for (const p of policies as Array<{ qual: string; with_check: string }>) {
      // USING and WITH CHECK must both use the mandatory `(SELECT ...)` wrapper.
      expect(p.qual).toMatch(INITPLAN_WRAPPER);
      expect(p.with_check).toMatch(INITPLAN_WRAPPER);
    }
  });

  it("evaluates the RLS predicate once per statement (EXPLAIN shows an InitPlan)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantA);
      const plan = (await tx.unsafe("EXPLAIN (COSTS OFF) SELECT * FROM calls"))
        .map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"])
        .join("\n");
      // The scalar sub-SELECT is hoisted to a once-per-statement InitPlan rather
      // than re-evaluated per row — the §5.10 perf requirement.
      expect(plan).toContain("InitPlan");
    });
  });

  it("resets ingest_degraded to false on a terminal status transition (§5.2 overlay)", async () => {
    const cid = randomUUID();
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, ingest_degraded)
              VALUES (${cid}, ${tenantA}, 'https://meet.google.com/x', 'IN_CALL', true)`;

    const before = await sql`SELECT ingest_degraded FROM calls WHERE id = ${cid}`;
    expect(before[0].ingest_degraded).toBe(true);

    await sql`UPDATE calls SET status = 'ENDED' WHERE id = ${cid}`;

    const after = await sql`SELECT ingest_degraded, status FROM calls WHERE id = ${cid}`;
    expect(after[0].status).toBe("ENDED");
    expect(after[0].ingest_degraded).toBe(false);

    await sql`DELETE FROM calls WHERE id = ${cid}`;
  });

  it("denies a cross-tenant UPDATE under samograph_app (0 rows, row unchanged)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantA);

      // The RLS USING filter hides tenant B's row, so the UPDATE matches nothing.
      const res = await tx`UPDATE calls SET region = 'hacked-by-A'
                           WHERE id = ${callB} RETURNING id`;
      expect(res.count).toBe(0);
      expect(res.length).toBe(0);
    });

    // Superuser (bypasses RLS) confirms tenant B's row is byte-for-byte unchanged.
    const b = await sql`SELECT region, status, ingest_degraded FROM calls WHERE id = ${callB}`;
    expect(b.length).toBe(1);
    expect(b[0].region).toBeNull();
    expect(b[0].status).toBe("IN_CALL");
    expect(b[0].ingest_degraded).toBe(true);
  });

  it("denies a cross-tenant DELETE under samograph_app (0 rows deleted, row survives)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantA);

      const res = await tx`DELETE FROM calls WHERE id = ${callB} RETURNING id`;
      expect(res.count).toBe(0);
      expect(res.length).toBe(0);
    });

    // Superuser confirms tenant B's call still exists — nothing was deleted.
    const survivors = await sql`SELECT count(*)::int AS c FROM calls WHERE id = ${callB}`;
    expect(survivors[0].c).toBe(1);
  });

  it("keeps ingest_degraded=true on a NON-terminal status UPDATE (trigger negative path §5.2)", async () => {
    const cid = randomUUID();
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, ingest_degraded)
              VALUES (${cid}, ${tenantA}, 'https://meet.google.com/y', 'JOINING', true)`;

    const before = await sql`SELECT status, ingest_degraded FROM calls WHERE id = ${cid}`;
    expect(before[0].status).toBe("JOINING");
    expect(before[0].ingest_degraded).toBe(true);

    // Fire the BEFORE UPDATE OF status trigger with a NON-terminal NEW.status.
    // Only ENDED/COULD_NOT_JOIN/COULD_NOT_RECORD/BOT_REMOVED clear the overlay,
    // so JOINING -> IN_CALL must leave ingest_degraded untouched.
    const res = await sql`UPDATE calls SET status = 'IN_CALL' WHERE id = ${cid} RETURNING status`;
    expect(res.count).toBe(1);
    expect(res[0].status).toBe("IN_CALL");

    const after = await sql`SELECT status, ingest_degraded FROM calls WHERE id = ${cid}`;
    expect(after[0].status).toBe("IN_CALL");
    expect(after[0].ingest_degraded).toBe(true);

    await sql`DELETE FROM calls WHERE id = ${cid}`;
  });

  it("rejects a duplicate (call_id, seq) on transcripts (append-only PK)", async () => {
    let caught: { errno?: string } | null = null;
    try {
      await sql`INSERT INTO transcripts (call_id, seq, ts, text)
                VALUES (${callA}, 1, now(), 'duplicate seq')`;
    } catch (err) {
      caught = err as { errno?: string };
    }
    expect(caught).not.toBeNull();
    // 23505 = unique_violation.
    expect(caught?.errno).toBe("23505");
  });
});
