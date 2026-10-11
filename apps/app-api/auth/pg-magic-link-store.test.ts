/**
 * Postgres integration test for the atomic, restart/replica-safe magic-link
 * store (SPEC §5.1, §5.10, §6.2 #6; issue #62).
 *
 * Runs against the CI ephemeral Postgres (real migrations 0001..0007, no mocks;
 * §6.1) and SKIPS cleanly when DATABASE_URL is unset — exactly like the
 * PostgresUserStore suite. Auth is a privileged pre-tenant path, so this
 * connects as the migration/superuser role (magic_links is deliberately
 * ungranted to samograph_app and carries no RLS, mirroring users/tenants).
 *
 * The single-atomic-UPDATE consume must make a CONCURRENT double-consume race
 * resolve to exactly one `consumed` and one `already_consumed` — the property
 * the JS read-modify-write of the in-memory store cannot guarantee across
 * replicas.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect, migrate } from "../../../packages/shared/db/index.ts";
import { PostgresMagicLinkStore } from "./pg-magic-link-store.ts";
import type { MagicLinkRecord } from "./types.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

let seq = 0;
function record(email: string, overrides: Partial<MagicLinkRecord> = {}): MagicLinkRecord {
  const iat = 1_700_000_000_000 + seq;
  return {
    jti: `jti-${Date.now()}-${seq++}`,
    email,
    kid: "test-kid-1",
    issuedAt: iat,
    expiresAt: iat + 15 * 60 * 1000,
    status: "outstanding",
    ...overrides,
  };
}

d("PostgresMagicLinkStore (§5.1 atomic consume + supersession)", () => {
  let sql: ReturnType<typeof connect>;
  const emails: string[] = [];
  const email = (label: string): string => {
    const e = `ml-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    emails.push(e);
    return e;
  };

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    for (const e of emails) await sql`DELETE FROM magic_links WHERE email = ${e}`;
    await sql.close();
  });

  it("issue then consume returns EXACTLY 'consumed' with the persisted record", async () => {
    const store = new PostgresMagicLinkStore(sql);
    const rec = record(email("consume"));
    await store.issue(rec);

    const persisted = await store.get(rec.jti);
    expect(persisted).toEqual({ ...rec, status: "outstanding" });

    const res = await store.consume(rec.jti);
    expect(res.outcome).toBe("consumed");
    if (res.outcome === "consumed") {
      expect(res.record).toEqual({ ...rec, status: "consumed" });
    }
    const after = await store.get(rec.jti);
    expect(after?.status).toBe("consumed");
  });

  it("replay (double consume, serial) returns EXACTLY 'already_consumed'", async () => {
    const store = new PostgresMagicLinkStore(sql);
    const rec = record(email("replay"));
    await store.issue(rec);

    expect((await store.consume(rec.jti)).outcome).toBe("consumed");
    const replay = await store.consume(rec.jti);
    expect(replay.outcome).toBe("already_consumed");
    if (replay.outcome === "already_consumed") {
      expect(replay.record.status).toBe("consumed");
    }
  });

  it("issuing a newer link supersedes the prior OUTSTANDING one for the email", async () => {
    const store = new PostgresMagicLinkStore(sql);
    const e = email("supersede");
    const first = record(e);
    const second = record(e);
    await store.issue(first);
    await store.issue(second);

    // The old link is superseded; consuming it yields EXACTLY 'superseded'.
    expect((await store.get(first.jti))?.status).toBe("superseded");
    const stale = await store.consume(first.jti);
    expect(stale.outcome).toBe("superseded");

    // The newest link is the only outstanding one; it consumes cleanly.
    expect((await store.get(second.jti))?.status).toBe("outstanding");
    expect((await store.consume(second.jti)).outcome).toBe("consumed");
  });

  it("supersession is email-scoped and case/space-insensitive; other emails untouched", async () => {
    const store = new PostgresMagicLinkStore(sql);
    const other = record(email("other"));
    await store.issue(other);

    const e = email("scoped");
    const a = record(e);
    const b = record(`  ${e.toUpperCase()}  `); // same identity after normalize
    await store.issue(a);
    await store.issue(b);

    expect((await store.get(a.jti))?.status).toBe("superseded");
    expect((await store.get(b.jti))?.status).toBe("outstanding");
    // b was stored with the normalized email.
    expect((await store.get(b.jti))?.email).toBe(e);
    // A different email's outstanding link is not disturbed.
    expect((await store.get(other.jti))?.status).toBe("outstanding");
  });

  it("consume of an unknown jti returns EXACTLY 'not_found' (no record)", async () => {
    const store = new PostgresMagicLinkStore(sql);
    const res = await store.consume(`nope-${Date.now()}`);
    expect(res).toEqual({ outcome: "not_found" });
  });

  it("CONCURRENT double-consume yields EXACTLY one 'consumed' and one 'already_consumed'", async () => {
    // Two independent connections so the two consumes truly race at the DB.
    const a = new PostgresMagicLinkStore(sql);
    const sqlB = connect();
    try {
      const b = new PostgresMagicLinkStore(sqlB);
      const rec = record(email("race"));
      await a.issue(rec);

      const [r1, r2] = await Promise.all([a.consume(rec.jti), b.consume(rec.jti)]);
      const outcomes = [r1.outcome, r2.outcome].sort();
      expect(outcomes).toEqual(["already_consumed", "consumed"]);

      // And the row settled on 'consumed' exactly once.
      const rows = await sql`SELECT status FROM magic_links WHERE jti = ${rec.jti}`;
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("consumed");
    } finally {
      await sqlB.close();
    }
  });
});
