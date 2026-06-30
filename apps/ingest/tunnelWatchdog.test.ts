/**
 * Server-side multi-call tunnel watchdog + advisory-lock leader election +
 * `ingest_degraded` fan-out — SPEC §4.5 / §4.6 / §6.2 #5 / §5.11 / §5.16; issue #81.
 *
 * The server-side analog of the CLI's mid-call tunnel watchdog (`src/server.ts`):
 * one per-region probe loop runs on exactly ONE ingest replica (Postgres
 * advisory lock + a persisted 60 s lease, §4.6) so "exactly one warning line per
 * outage" survives horizontal scaling. On 2 consecutive probe failures the
 * leader flips the region to `degraded`, sets `calls.ingest_degraded=true` for
 * every IN_CALL call in the region, and fans a `SAMOGRAPH-WARNING: tunnel
 * unreachable …` control line (the CLI's exact text — REUSED from `src/server.ts`,
 * not reimplemented) onto each affected call's channel via the merged
 * `TranscriptPublisher` (#95). Recovery reverses all three.
 *
 * No tokens, no real network, no real sleep: the probe `fetch` is injected and
 * time is a virtual clock the test advances by hand (§6.1). Every assertion is
 * exact-value (counts, ids, byte-identical text). The persistence cases need the
 * real `regions`/`calls` tables + the §5.2 terminal-reset trigger and are gated
 * on DATABASE_URL (the Postgres-smoke job runs the whole suite; each skips
 * cleanly when it is unset).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  tunnelUnreachableWarning,
  TUNNEL_RECOVERED_WARNING,
  type HealthFetch,
} from "../../src/server.ts";
import { InMemoryTranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";
import { connect } from "../../packages/shared/db/index.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import {
  startRegionWatchdog,
  inMemoryWatchdogMetrics,
  type RegionWatchdogHandle,
} from "./tunnelWatchdog.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (no DB) — the metrics fake + the CLI-text reuse contract.
// ─────────────────────────────────────────────────────────────────────────────
describe("watchdog metrics + warning text (no DB)", () => {
  it("inMemoryWatchdogMetrics counts tunnel_probe_failed_total per region (§5.11)", () => {
    const m = inMemoryWatchdogMetrics();
    expect(m.failed).toEqual({});
    m.incTunnelProbeFailed("eu-central");
    m.incTunnelProbeFailed("eu-central");
    m.incTunnelProbeFailed("us-east");
    expect(m.failed).toEqual({ "eu-central": 2, "us-east": 1 });
  });

  it("reuses the CLI's exact SAMOGRAPH-WARNING text (no drift, §4.5)", () => {
    const w = tunnelUnreachableWarning("health check failed");
    expect(w).toBe(
      "SAMOGRAPH-WARNING: tunnel unreachable (health check failed) - transcript " +
        "may be incomplete; rejoin with --tunnel cloudflared or --webhook-base",
    );
    expect(tunnelUnreachableWarning("ERR_NGROK_727")).toContain("(ERR_NGROK_727)");
    expect(TUNNEL_RECOVERED_WARNING).toBe(
      "SAMOGRAPH-WARNING: tunnel recovered - live transcript delivery resumed",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed cases — real regions/calls tables, RLS-bypassing infra path, the
// §5.2 terminal-reset trigger, and the advisory-lock lease (§6.2 #5).
// ─────────────────────────────────────────────────────────────────────────────
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

/** A health probe that echoes the nonce when "up" and throws when "down". */
function controllableFetch(state: { up: boolean; probes: number }): HealthFetch {
  return async (url) => {
    state.probes += 1;
    if (!state.up) throw new Error("tunnel down");
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    return Response.json({ ok: true, nonce, marker: "samograph-health" });
  };
}

d("region tunnel watchdog (§4.5/§4.6/§6.2 #5)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const tenantA = randomUUID();
  const userB = randomUUID();
  const tenantB = randomUUID();

  const regionIds: string[] = [];
  const callIds: string[] = [];
  const extraConns: Array<ReturnType<typeof connect>> = [];

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
  });

  afterEach(async () => {
    for (const c of extraConns.splice(0)) await c.close();
    if (callIds.length) await sql`DELETE FROM calls WHERE id IN ${sql(callIds.splice(0))}`;
    if (regionIds.length) await sql`DELETE FROM regions WHERE id IN ${sql(regionIds.splice(0))}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  /** Fresh region row (unique id so tests never collide on the shared table). */
  async function freshRegion(status = "healthy"): Promise<string> {
    const id = `eu-${randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO regions (id, tunnel_hostname, status)
              VALUES (${id}, ${`https://${id}.tunnel.test`}, ${status})`;
    regionIds.push(id);
    return id;
  }

  async function seedCall(
    tenantId: string,
    region: string,
    status: string,
    ingestDegraded = false,
  ): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, ingest_degraded)
              VALUES (${id}, ${tenantId}, ${`https://meet.google.com/${id}`},
                      ${status}::call_status, ${region}, ${ingestDegraded})`;
    callIds.push(id);
    return id;
  }

  const degradedOf = async (id: string): Promise<boolean> =>
    (await sql`SELECT ingest_degraded FROM calls WHERE id = ${id}`)[0].ingest_degraded;
  const regionStatus = async (id: string): Promise<string> =>
    (await sql`SELECT status FROM regions WHERE id = ${id}`)[0].status;

  // ───────────────────────────────────────────────────────────────────────────
  it("#1 single-process: 2 consecutive failures degrade the region, warn every IN_CALL call, flip ingest_degraded for exactly those", async () => {
    const region = await freshRegion();
    const other = await freshRegion(); // a DIFFERENT region — must be untouched
    const callA = await seedCall(tenantA, region, "IN_CALL");
    const callB = await seedCall(tenantB, region, "IN_CALL");
    const callOther = await seedCall(tenantA, other, "IN_CALL");
    const callEnded = await seedCall(tenantB, region, "ENDED");

    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryWatchdogMetrics();
    const net = { up: false, probes: 0 };
    let clock = new Date("2026-06-29T12:00:00Z");
    const wd = startRegionWatchdog({
      sql,
      regionId: region,
      replicaId: "ingest-1",
      publisher,
      metrics,
      fetch: controllableFetch(net),
      now: () => clock,
    });

    // One failure could be a blip — no warning, region still healthy.
    await wd.tick();
    expect(await regionStatus(region)).toBe("healthy");
    expect(publisher.published).toHaveLength(0);
    expect(await degradedOf(callA)).toBe(false);

    // Second consecutive failure → degrade + fan-out.
    clock = new Date(clock.getTime() + 20_000);
    await wd.tick();

    expect(await regionStatus(region)).toBe("degraded");
    expect(await degradedOf(callA)).toBe(true);
    expect(await degradedOf(callB)).toBe(true);
    // Isolation: other region + non-IN_CALL call are untouched.
    expect(await degradedOf(callOther)).toBe(false);
    expect(await degradedOf(callEnded)).toBe(false);
    expect(await regionStatus(other)).toBe("healthy");

    // Exactly one warning per affected call, carrying the CLI's exact text.
    const expected = tunnelUnreachableWarning("health check failed");
    const warnA = publisher.framesFor(callA).filter((f) => f.type === "warning");
    const warnB = publisher.framesFor(callB).filter((f) => f.type === "warning");
    expect(warnA).toHaveLength(1);
    expect(warnB).toHaveLength(1);
    expect(warnA[0].text).toBe(expected);
    expect(publisher.framesFor(callOther)).toHaveLength(0);
    expect(publisher.framesFor(callEnded)).toHaveLength(0);
    // No warning multiplication: 2 calls → exactly 2 frames cluster-wide.
    expect(publisher.published).toHaveLength(2);
    expect(metrics.failed[region]).toBe(2);

    // Continued failure does NOT re-warn (latched on regions.status).
    clock = new Date(clock.getTime() + 20_000);
    await wd.tick();
    expect(publisher.published).toHaveLength(2);
    expect(metrics.failed[region]).toBe(3);
    wd.stop();
  });

  it("#2 recovery: a successful probe clears ingest_degraded, clears the banner, and writes exactly one recovered line", async () => {
    const region = await freshRegion("degraded");
    const callA = await seedCall(tenantA, region, "IN_CALL", true);
    const callB = await seedCall(tenantB, region, "IN_CALL", true);

    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryWatchdogMetrics();
    const net = { up: true, probes: 0 };
    let clock = new Date("2026-06-29T12:00:00Z");
    const wd = startRegionWatchdog({
      sql, regionId: region, replicaId: "ingest-1", publisher, metrics,
      fetch: controllableFetch(net), now: () => clock,
    });

    await wd.tick();

    expect(await regionStatus(region)).toBe("healthy");
    expect(await degradedOf(callA)).toBe(false);
    expect(await degradedOf(callB)).toBe(false);
    const recA = publisher.framesFor(callA).filter((f) => f.type === "warning");
    expect(recA).toHaveLength(1);
    expect(recA[0].text).toBe(TUNNEL_RECOVERED_WARNING);
    expect(publisher.published).toHaveLength(2); // one per call, no more

    // Further successes do not repeat the recovered line.
    clock = new Date(clock.getTime() + 20_000);
    await wd.tick();
    expect(publisher.published).toHaveLength(2);
    wd.stop();
  });

  it("#3 flapping (fail → pass → fail) within the threshold never degrades and never spams", async () => {
    const region = await freshRegion();
    const callA = await seedCall(tenantA, region, "IN_CALL");

    const publisher = new InMemoryTranscriptPublisher();
    const net = { up: false, probes: 0 };
    let clock = new Date("2026-06-29T12:00:00Z");
    const wd = startRegionWatchdog({
      sql, regionId: region, replicaId: "ingest-1", publisher,
      metrics: inMemoryWatchdogMetrics(), fetch: controllableFetch(net), now: () => clock,
    });

    await wd.tick(); // fail (1) — below threshold
    net.up = true;
    clock = new Date(clock.getTime() + 20_000);
    await wd.tick(); // pass — resets the counter, region was never degraded
    net.up = false;
    clock = new Date(clock.getTime() + 20_000);
    await wd.tick(); // fail (1 again)

    expect(await regionStatus(region)).toBe("healthy");
    expect(await degradedOf(callA)).toBe(false);
    expect(publisher.published).toHaveLength(0);
    wd.stop();
  });

  it("#4 distributed: 3 replicas race the lock → one leader; leader-death fails over; warn/recover exactly once across the cluster", async () => {
    const region = await freshRegion();
    const callA = await seedCall(tenantA, region, "IN_CALL");

    const publisher = new InMemoryTranscriptPublisher(); // shared cluster fan-out
    const metrics = inMemoryWatchdogMetrics();
    const net = { up: false, probes: 0 };
    let clock = new Date("2026-06-29T12:00:00Z");

    // Three replicas, each with its OWN Postgres connection so the advisory lock
    // actually arbitrates (followers run no probes).
    const replicas: RegionWatchdogHandle[] = ["r1", "r2", "r3"].map((id) => {
      const conn = connect();
      extraConns.push(conn);
      return startRegionWatchdog({
        sql: conn, regionId: region, replicaId: id, publisher, metrics,
        fetch: controllableFetch(net), now: () => clock, leaseMs: 60_000,
      });
    });

    // Round 1: all three tick — exactly one becomes leader, only it probes.
    for (const r of replicas) await r.tick();
    expect(replicas.filter((r) => r.isLeader())).toHaveLength(1);
    expect(net.probes).toBe(1);
    const leaderIdx = replicas.findIndex((r) => r.isLeader());

    // Drive the leader to 2 consecutive failures → exactly one warning cluster-wide.
    clock = new Date(clock.getTime() + 20_000);
    for (const r of replicas) await r.tick();
    expect(await regionStatus(region)).toBe("degraded");
    expect(await degradedOf(callA)).toBe(true);
    expect(publisher.framesFor(callA).filter((f) => f.type === "warning")).toHaveLength(1);

    // Kill the leader: it stops ticking and its 60 s lease lapses.
    const survivors = replicas.filter((_, i) => i !== leaderIdx);
    clock = new Date(clock.getTime() + 61_000);
    for (const r of survivors) await r.tick();
    // A new leader takes over within ≤ lease + probe interval …
    expect(survivors.filter((r) => r.isLeader())).toHaveLength(1);
    // … and does NOT emit a second warning for the same ongoing outage.
    expect(publisher.framesFor(callA).filter((f) => f.type === "warning")).toHaveLength(1);

    // Recovery happens exactly once, driven by the new leader.
    net.up = true;
    clock = new Date(clock.getTime() + 20_000);
    for (const r of survivors) await r.tick();
    expect(await regionStatus(region)).toBe("healthy");
    expect(await degradedOf(callA)).toBe(false);
    const rec = publisher
      .framesFor(callA)
      .filter((f) => f.type === "warning" && f.text === TUNNEL_RECOVERED_WARNING);
    expect(rec).toHaveLength(1);
    for (const r of replicas) r.stop();
  });

  it("#5 a call going terminal mid-outage has ingest_degraded reset by the trigger and gets no recovery line", async () => {
    const region = await freshRegion("degraded");
    const callA = await seedCall(tenantA, region, "IN_CALL", true);

    // The §5.2 terminal-reset trigger fires even while the region is degraded.
    await sql`UPDATE calls SET status = 'ENDED' WHERE id = ${callA}`;
    expect(await degradedOf(callA)).toBe(false);
    expect((await sql`SELECT status FROM calls WHERE id = ${callA}`)[0].status).toBe("ENDED");

    // On recovery the now-terminal call receives no recovered line (not IN_CALL).
    const publisher = new InMemoryTranscriptPublisher();
    const net = { up: true, probes: 0 };
    const clock = new Date("2026-06-29T12:00:00Z");
    const wd = startRegionWatchdog({
      sql, regionId: region, replicaId: "ingest-1", publisher,
      metrics: inMemoryWatchdogMetrics(), fetch: controllableFetch(net), now: () => clock,
    });
    await wd.tick();
    expect(await regionStatus(region)).toBe("healthy");
    expect(publisher.framesFor(callA)).toHaveLength(0);
    wd.stop();
  });
});
