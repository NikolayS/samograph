/**
 * OUTAGE watchdog → LIVE page bridge (SPEC §3 Story 5, §4.5, §4.6, §5.10).
 *
 * RED (before this issue): `startRegionWatchdogs` existed but had NO production
 * caller — the deployed live transport (`dev-live-server.ts` composing ingest +
 * ws-hub on ONE in-process Hub) never probed the tunnel, so a real outage
 * silently froze the transcript: no `SAMOGRAPH-WARNING` line, no
 * `ingest_degraded` banner. The fan-in also dropped control frames, so even a
 * hand-run watchdog could never reach an open page.
 *
 * GREEN: `startLiveWatchdogBridge` seeds the region row, runs the REAL
 * leader-elected watchdog (§4.6 — unchanged), persists each warning as a
 * `SAMOGRAPH-WARNING` transcript line (so it has a real `seq`, survives
 * reconnect/backfill, and rides the EXISTING line path), and delivers it to the
 * shared Hub after the watchdog tx commits — an OPEN WS page receives it live
 * and the reducer flips the degraded overlay (Story 5).
 *
 * Injectable probe (fake /health) + injectable clock — no real network beyond
 * loopback, no real sleep. DB-gated; skips cleanly when DATABASE_URL is unset.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import {
  probeTunnelHealth,
  tunnelUnreachableWarning,
  TUNNEL_RECOVERED_WARNING,
  type HealthFetch,
} from "../../src/server.ts";
import { inMemoryWebhookSecretProvider } from "../ingest/webhook.ts";
import { inMemoryWatchdogMetrics } from "../ingest/tunnelWatchdog.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { Session } from "../../packages/shared/auth/index.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { composeLiveStack, type LiveStackHandle } from "./liveBridge.ts";
import {
  ensureRegion,
  startLiveWatchdogBridge,
  WARNING_SPEAKER,
  type LiveWatchdogHandle,
} from "./watchdogBridge.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const KEY: SigningKey = { kid: "wb1", secret: "watchdog-bridge-secret-aaaaaaaaaaaaaaaaaaaa" };
const keyring: Keyring = { current: KEY };

/** A health probe that echoes the nonce+marker when "up" and throws when "down". */
function controllableFetch(state: { up: boolean; probes: number }): HealthFetch {
  return async (url) => {
    state.probes += 1;
    if (!state.up) throw new Error("tunnel down");
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    return Response.json({ ok: true, nonce, marker: "samograph-health" });
  };
}

/** A WS client that records frames and lets a test await one matching a predicate. */
function openClient(baseWsUrl: string, callId: string, cookie: string) {
  const u = new URL(`${baseWsUrl}/calls/${callId}/stream`);
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
  const ws = new WebSocket(u.toString().replace(/^http/, "ws"), { headers } as unknown as string[]);

  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    pred: (f: Record<string, unknown>) => boolean;
    resolve: (f: Record<string, unknown>) => void;
  }> = [];
  ws.onmessage = (e: MessageEvent) => {
    const f = JSON.parse(String(e.data)) as Record<string, unknown>;
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) {
        waiters[i].resolve(f);
        waiters.splice(i, 1);
      }
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error / upgrade refused"));
  });
  function waitFor(
    pred: (f: Record<string, unknown>) => boolean,
    ms = 4000,
  ): Promise<Record<string, unknown>> {
    const existing = frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  }
  return { ws, frames, opened, waitFor };
}

/** Poll `cond` until true or timeout (deterministic barrier, no fixed sleeps). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

d("outage watchdog → live page bridge (Story 5, §4.5/§4.6/§5.10)", () => {
  let sql: SQL;
  let stack: LiveStackHandle;

  const userA = randomUUID();
  const tenantA = randomUUID();

  const regionIds: string[] = [];
  const callIds: string[] = [];
  const handles: LiveWatchdogHandle[] = [];

  const authDeps: StreamAuthDeps = {
    keyring,
    lookupSession: async (c) =>
      c === "cookie-A" ? ({ userId: userA, tenantId: tenantA } as Session) : null,
    lookupCallTenant: async (id) => {
      try {
        const r = await sql`SELECT tenant_id FROM calls WHERE id = ${id}`;
        return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
      } catch {
        return null;
      }
    },
  };

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${`${userA}@a.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA})`;
    stack = composeLiveStack({
      sql,
      authDeps,
      secretProvider: inMemoryWebhookSecretProvider("watchdog-bridge-webhook-secret"),
    });
  });

  afterEach(async () => {
    for (const h of handles.splice(0)) h.stop();
    if (callIds.length) await sql`DELETE FROM calls WHERE id IN ${sql(callIds.splice(0))}`;
    if (regionIds.length) await sql`DELETE FROM regions WHERE id IN ${sql(regionIds.splice(0))}`;
  });

  afterAll(async () => {
    await stack.stop();
    await sql`DELETE FROM users WHERE id = ${userA}`; // CASCADE clears tenant/calls/transcripts
    await sql.close();
  }, 10000);

  function freshRegionId(): string {
    const id = `wd-${randomUUID().slice(0, 8)}`;
    regionIds.push(id);
    return id;
  }

  async function freshInCall(regionId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region)
      VALUES (${id}, ${tenantA}, 'https://meet.google.com/wdb', 'IN_CALL', ${regionId})`;
    callIds.push(id);
    return id;
  }

  async function startBridge(regionId: string, probe: HealthFetch): Promise<LiveWatchdogHandle> {
    let t = Date.UTC(2026, 6, 7, 12, 0, 0);
    const handle = await startLiveWatchdogBridge({
      sql,
      fanIn: stack.fanIn,
      regionId,
      probeBase: `https://${regionId}.tunnel.test`,
      replicaId: `test-${regionId}`,
      metrics: inMemoryWatchdogMetrics(),
      fetch: probe,
      now: () => new Date((t += 20_000)), // injected clock: +20 s per tick
      schedule: () => ({ stop() {} }), // tests drive tick() by hand
    });
    handles.push(handle);
    return handle;
  }

  it("ensureRegion seeds a missing region row and idempotently refreshes the probe target", async () => {
    const regionId = freshRegionId();
    await ensureRegion(sql, regionId, "https://first.tunnel.test");
    const seeded = await sql`
      SELECT id, tunnel_hostname, status FROM regions WHERE id = ${regionId}`;
    expect(seeded).toEqual([
      { id: regionId, tunnel_hostname: "https://first.tunnel.test", status: "healthy" },
    ]);

    // Re-seeding is idempotent and follows a changed PUBLIC_WEBHOOK_BASE, but
    // never resets a live status (a restart mid-outage must not clear degraded).
    await sql`UPDATE regions SET status = 'degraded' WHERE id = ${regionId}`;
    await ensureRegion(sql, regionId, "https://second.tunnel.test");
    const reseeded = await sql`
      SELECT id, tunnel_hostname, status FROM regions WHERE id = ${regionId}`;
    expect(reseeded).toEqual([
      { id: regionId, tunnel_hostname: "https://second.tunnel.test", status: "degraded" },
    ]);
  });

  it("2 failed probes → ingest_degraded=true + EXACTLY ONE warning line on the open page; recovery → one recovered line + cleared", async () => {
    const regionId = freshRegionId();
    const callId = await freshInCall(regionId);
    // Pre-existing conversation: the warning must get the NEXT per-call seq.
    await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text)
      VALUES (${callId}, 5, '2026-07-07 11:59:00+00', 'Alice', 'before the outage')`;

    const client = openClient(stack.wsHub.url, callId, "cookie-A");
    await client.opened;
    await until(() => stack.hub.subscriberCount(callId) >= 1);

    const probe = { up: true, probes: 0 };
    const bridge = await startBridge(regionId, controllableFetch(probe));

    // Healthy probe: nothing published, nothing degraded.
    await bridge.tick();
    expect(bridge.isLeader()).toBe(true);
    expect(client.frames.filter((f) => f.speaker === WARNING_SPEAKER)).toEqual([]);

    // Outage: failure #1 is a blip (threshold 2) — still silent.
    probe.up = false;
    await bridge.tick();
    expect(client.frames.filter((f) => f.speaker === WARNING_SPEAKER)).toEqual([]);
    expect(
      (await sql`SELECT ingest_degraded FROM calls WHERE id = ${callId}`)[0].ingest_degraded,
    ).toBe(false);

    // Failure #2 → degraded: the exact CLI warning text arrives on the OPEN socket
    // as a finalized SAMOGRAPH-WARNING line with the next per-call seq.
    await bridge.tick();
    const warning = await client.waitFor((f) => f.speaker === WARNING_SPEAKER);
    expect(warning).toEqual({
      type: "line",
      seq: 6,
      ts: "2026-07-07 12:01:00",
      speaker: WARNING_SPEAKER,
      text: tunnelUnreachableWarning("health check failed"),
      final: true,
    });
    expect(
      (await sql`SELECT ingest_degraded FROM calls WHERE id = ${callId}`)[0].ingest_degraded,
    ).toBe(true);

    // The warning is PERSISTED (a reconnecting page backfills it, §5.5).
    const rows = (await sql`
      SELECT seq, speaker, text FROM transcripts WHERE call_id = ${callId} AND seq = 6`) as unknown as Array<{ seq: unknown; speaker: string; text: string }>;
    expect(rows.map((r) => ({ ...r, seq: Number(r.seq) }))).toEqual([
      { seq: 6, speaker: WARNING_SPEAKER, text: tunnelUnreachableWarning("health check failed") },
    ]);

    // Failure #3 (outage continues) → NO second warning: exactly one per outage.
    await bridge.tick();
    expect(client.frames.filter((f) => f.speaker === WARNING_SPEAKER)).toHaveLength(1);

    // Recovery → exactly one recovered line + the overlay clears.
    probe.up = true;
    await bridge.tick();
    const recovered = await client.waitFor(
      (f) => f.speaker === WARNING_SPEAKER && String(f.text).includes("recovered"),
    );
    expect(recovered).toEqual({
      type: "line",
      seq: 7,
      ts: "2026-07-07 12:01:40", // the 5th tick of the +20 s virtual clock
      speaker: WARNING_SPEAKER,
      text: TUNNEL_RECOVERED_WARNING,
      final: true,
    });
    expect(
      (await sql`SELECT ingest_degraded FROM calls WHERE id = ${callId}`)[0].ingest_degraded,
    ).toBe(false);

    // Still healthy → no further lines: exactly 2 warnings total for the episode.
    await bridge.tick();
    expect(client.frames.filter((f) => f.speaker === WARNING_SPEAKER)).toHaveLength(2);

    client.ws.close();
  });

  it("flapping below the threshold never spams: fail,ok,fail,ok publishes nothing", async () => {
    const regionId = freshRegionId();
    const callId = await freshInCall(regionId);

    const client = openClient(stack.wsHub.url, callId, "cookie-A");
    await client.opened;
    await until(() => stack.hub.subscriberCount(callId) >= 1);

    const probe = { up: true, probes: 0 };
    const bridge = await startBridge(regionId, controllableFetch(probe));

    for (const up of [false, true, false, true]) {
      probe.up = up;
      await bridge.tick();
    }
    expect(probe.probes).toBe(4);
    expect(client.frames.filter((f) => f.speaker === WARNING_SPEAKER)).toEqual([]);
    expect(
      (await sql`SELECT ingest_degraded FROM calls WHERE id = ${callId}`)[0].ingest_degraded,
    ).toBe(false);
    const persisted = (await sql`
      SELECT 1 FROM transcripts WHERE call_id = ${callId}`) as unknown as unknown[];
    expect(persisted).toHaveLength(0);

    client.ws.close();
  });

  it("the composed ingest /health is a valid §4.5 probe target (byte-exact marker + nonce echo)", async () => {
    // The bridge probes PUBLIC_WEBHOOK_BASE + /health — which fronts THIS composed
    // ingest. The REAL probe (nonce round-trip + samograph-health marker) must pass.
    const probe = await probeTunnelHealth(stack.ingest.url, (url, init) => fetch(url, init));
    expect(probe).toEqual({ ok: true, ngrokErrorCode: null });
  });
});
