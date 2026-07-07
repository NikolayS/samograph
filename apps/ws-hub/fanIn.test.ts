/**
 * ws-hub fan-in — re-hydrate a §98 line signal by seq, under RLS (SPEC §5.5/§5.10,
 * issue #99/#98). DB-gated (real Postgres + RLS); skips when DATABASE_URL is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { Hub } from "./hub.ts";
import { createFanIn, fetchLineFrame } from "./fanIn.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

// ─── ctl lane (#106): status control frames are live-forwarded — pure, no DB ──
describe("fan-in ctl lane: a status control signal reaches the Hub (#106)", () => {
  const callX = randomUUID();

  it("publishes a {k:'ctl'} status frame verbatim onto the call's channel", async () => {
    const hub = new Hub();
    const sub = hub.subscribe(callX);
    // sql/lookup are never touched on the ctl path — a throw here would fail the test.
    const fanIn = createFanIn({
      sql: null as never,
      hub,
      lookupCallTenant: async () => {
        throw new Error("ctl path must not resolve tenants");
      },
    });

    const res = await fanIn.deliver({
      k: "ctl",
      frame: { type: "status", call_id: callX, status: "IN_CALL" },
    });
    expect(res).toBeNull(); // deliver still returns line frames only
    expect(sub.drain()).toEqual([{ type: "status", call_id: callX, status: "IN_CALL" }]);
  });

  it("non-status ctl frames stay a no-op (warning/degraded live lanes are follow-ups)", async () => {
    const hub = new Hub();
    const sub = hub.subscribe(callX);
    const fanIn = createFanIn({ sql: null as never, hub, lookupCallTenant: async () => null });

    expect(
      await fanIn.deliver({ k: "ctl", frame: { type: "warning", call_id: callX, text: "x" } }),
    ).toBeNull();
    expect(
      await fanIn.deliver({ k: "ctl", frame: { type: "degraded", call_id: callX, degraded: true } }),
    ).toBeNull();
    expect(sub.drain()).toEqual([]);
  });

  it("is channel-isolated: another call's subscriber sees nothing", async () => {
    const hub = new Hub();
    const other = hub.subscribe(randomUUID());
    const fanIn = createFanIn({ sql: null as never, hub, lookupCallTenant: async () => null });
    await fanIn.deliver({ k: "ctl", frame: { type: "status", call_id: callX, status: "ENDED" } });
    expect(other.drain()).toEqual([]);
  });
});

d("fan-in: fetch line by seq under RLS, publish to the Hub (#99/#98)", () => {
  let sql: SQL;
  const userA = randomUUID();
  const tenantA = randomUUID();
  const callA = randomUUID();
  const userB = randomUUID();
  const tenantB = randomUUID();
  const callB = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/fa', 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://meet.google.com/fb', 'IN_CALL')`;
    await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text) VALUES
      (${callA}, 5, '2026-01-01 00:01:30+00', 'Alice', 'hydrated by seq')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  const lookupCallTenant = async (id: string) => {
    const r = await sql`SELECT tenant_id FROM calls WHERE id = ${id}`;
    return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
  };

  it("fetchLineFrame returns the exact canonical line frame under the call's tenant", async () => {
    const frame = await fetchLineFrame(sql, tenantA, callA, 5);
    expect(frame).toEqual({
      type: "line",
      call_id: callA,
      seq: 5,
      ts: "2026-01-01 00:01:30",
      speaker: "Alice",
      text: "hydrated by seq",
    });
  });

  it("fetchLineFrame under the WRONG tenant returns null (RLS scoping)", async () => {
    expect(await fetchLineFrame(sql, tenantB, callA, 5)).toBeNull();
  });

  it("deliver publishes the re-hydrated line onto the Hub; a missing seq is a no-op", async () => {
    const hub = new Hub();
    const sub = hub.subscribe(callA);
    const fanIn = createFanIn({ sql, hub, lookupCallTenant });

    const published = await fanIn.deliver({ k: "line", call_id: callA, seq: 5 });
    expect(published?.text).toBe("hydrated by seq");
    expect(sub.drain()).toEqual([
      { type: "line", call_id: callA, seq: 5, ts: "2026-01-01 00:01:30", speaker: "Alice", text: "hydrated by seq" },
    ]);

    // A seq with no row publishes nothing.
    expect(await fanIn.deliver({ k: "line", call_id: callA, seq: 999 })).toBeNull();
    expect(sub.drain()).toEqual([]);

    // A control signal is not live-forwarded in v1 (follow-up) — no-op, no throw.
    expect(await fanIn.deliver({ k: "ctl", frame: { type: "warning", call_id: callA, text: "x" } })).toBeNull();
  });
});
