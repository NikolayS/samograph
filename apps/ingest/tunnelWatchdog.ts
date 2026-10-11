/**
 * Server-side multi-call tunnel watchdog + advisory-lock leader election +
 * `ingest_degraded` fan-out (SPEC §4.5, §4.6, §5.11, §5.16; issue #81).
 *
 * The server-side analog of the CLI's mid-call tunnel watchdog
 * (`src/server.ts:startTunnelWatchdog`). Ingest scales horizontally, so the
 * per-region probe must run on exactly ONE replica or every replica would
 * multiply the warning. Leadership is a Postgres advisory lock keyed on the
 * region plus a persisted 60 s lease (`regions.leader_id` /
 * `regions.leader_lease_expires_at`) renewed every 20 s; a dead leader stops
 * renewing and its lease lapses, so a follower takes over within ≤ lease + probe
 * interval (§4.6). Followers run NO probes and emit nothing.
 *
 * On 2 consecutive probe failures the leader flips the region to `degraded`
 * (§4.5): an atomic conditional `UPDATE regions … WHERE status <> 'degraded'
 * RETURNING` is the once-per-outage gate, so warn/recover fire **exactly once
 * across the cluster** even through a leader handoff (the latch is the persisted
 * `regions.status`, not in-process state). The transition then (a) sets
 * `calls.ingest_degraded = true` for every IN_CALL call in the region and (b)
 * fans a `SAMOGRAPH-WARNING: tunnel unreachable …` control line — the CLI's
 * EXACT text, reused from `src/server.ts` — onto each affected call's channel via
 * the `TranscriptPublisher` (#95). Recovery reverses all three (one recovered
 * line, clear the overlay, clear the banner).
 *
 * This is an INFRA path: `regions` is not tenant-scoped and the cross-tenant
 * `calls` fan-out must see every tenant, so the watchdog runs on a privileged
 * connection that bypasses RLS (NOT the `samograph_app` tenant role). The probe
 * `fetch` and the clock are injected so it is driven with a virtual clock and an
 * in-memory probe in tests — no real network, no real sleep (§6.1).
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import {
  probeTunnelHealth,
  tunnelUnreachableWarning,
  TUNNEL_RECOVERED_WARNING,
  type HealthFetch,
} from "../../src/server.ts";
import type { TranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";

/** Default per-region probe interval (§4.5: 20 s server-side). */
export const SERVER_TUNNEL_PROBE_INTERVAL_MS = 20_000;
/** Leader lease (§4.6: 60 s, renewed every probe). */
export const LEADER_LEASE_MS = 60_000;
/** Two consecutive failed probes before warning — one failure can be a blip (§4.5). */
export const TUNNEL_WATCHDOG_FAILURE_THRESHOLD = 2;

/** Counter port for `tunnel_probe_failed_total{region}` (§5.11). */
export interface WatchdogMetrics {
  incTunnelProbeFailed(region: string): void;
}

/** In-memory {@link WatchdogMetrics} for tests — exposes the per-region counts. */
export function inMemoryWatchdogMetrics(): WatchdogMetrics & {
  failed: Record<string, number>;
} {
  const failed: Record<string, number> = {};
  return {
    failed,
    incTunnelProbeFailed(region) {
      failed[region] = (failed[region] ?? 0) + 1;
    },
  };
}

export interface RegionWatchdogDeps {
  /** Privileged infra connection (bypasses RLS: `regions` + cross-tenant `calls`). */
  sql: SQL;
  /** The region this replica watches (the advisory-lock + lease key). */
  regionId: string;
  /** Unique id of THIS ingest replica (the leader identity persisted in `regions`). */
  replicaId: string;
  /** Per-`call_id` fan-out seam (#95) — control frames ride the same channel as lines. */
  publisher: TranscriptPublisher;
  /** `tunnel_probe_failed_total{region}` counter (§5.11). */
  metrics: WatchdogMetrics;
  /** Injected health probe (no real network in tests). */
  fetch: HealthFetch;
  /** Virtual clock — drives lease expiry/renewal and frame timestamps. */
  now: () => Date;
  /** Probe nonce source (defaults to `randomUUID`). */
  nonce?: () => string;
  /** Leader lease in ms (defaults to {@link LEADER_LEASE_MS}). */
  leaseMs?: number;
  /** Consecutive failures before degrading (defaults to {@link TUNNEL_WATCHDOG_FAILURE_THRESHOLD}). */
  failureThreshold?: number;
  /** Probe interval for the background loop (defaults to {@link SERVER_TUNNEL_PROBE_INTERVAL_MS}). */
  intervalMs?: number;
  /** Scheduler seam (defaults to an unref'd `setInterval`); tests drive `tick()` directly. */
  schedule?: (fn: () => void, ms: number) => { stop(): void };
}

export interface RegionWatchdogHandle {
  /** Run ONE election + (leader-only) probe + transition. The schedule calls it. */
  tick(): Promise<void>;
  /** Whether this replica held leadership as of its last {@link tick}. */
  isLeader(): boolean;
  stop(): void;
}

/** Postgres timestamptz literal from a JS Date (UTC). */
function tsLiteral(d: Date): string {
  return d.toISOString();
}

/** Canonical `YYYY-MM-DD HH:MM:SS` (UTC) — matches the stored transcript ts. */
function canonicalTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Normalize a stored `tunnel_hostname` into a probe base URL (default https). */
function toBaseUrl(hostname: string): string {
  const h = hostname.replace(/\/+$/, "");
  return /^https?:\/\//i.test(h) ? h : `https://${h}`;
}

function defaultSchedule(fn: () => void, ms: number): { stop(): void } {
  const timer = setInterval(fn, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Start a per-region tunnel watchdog (§4.5/§4.6). The returned handle's `tick()`
 * is the unit the scheduler invokes (and the unit tests drive with a virtual
 * clock); it elects, and only when this replica is the leader does it probe and
 * apply the degrade/recover transition.
 */
export function startRegionWatchdog(deps: RegionWatchdogDeps): RegionWatchdogHandle {
  const {
    sql,
    regionId,
    replicaId,
    publisher,
    metrics,
    fetch: fetchFn,
    now,
  } = deps;
  const nonceFn = deps.nonce ?? randomUUID;
  const leaseMs = deps.leaseMs ?? LEADER_LEASE_MS;
  const threshold = deps.failureThreshold ?? TUNNEL_WATCHDOG_FAILURE_THRESHOLD;

  let consecutiveFailures = 0;
  let leader = false;

  /**
   * Acquire/renew leadership for `regionId`. The advisory lock serializes the
   * election among concurrently-ticking replicas (§4.6); the atomic conditional
   * UPDATE is the actual claim — it matches when this replica already leads, when
   * the seat is empty, or when the prior lease has lapsed — so only one replica
   * can hold a live lease at a time. Returns the region's tunnel hostname when
   * leader, or `null` when the region row does not exist.
   */
  async function elect(at: Date): Promise<{ isLeader: boolean; tunnelHostname: string } | null> {
    const leaseExpiry = new Date(at.getTime() + leaseMs);
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`samograph-leader:${regionId}`}))`;
      const claimed = (await tx`
        UPDATE regions
           SET leader_id = ${replicaId},
               leader_lease_expires_at = ${tsLiteral(leaseExpiry)}::timestamptz
         WHERE id = ${regionId}
           AND ( leader_id = ${replicaId}
              OR leader_id IS NULL
              OR leader_lease_expires_at IS NULL
              OR leader_lease_expires_at < ${tsLiteral(at)}::timestamptz )
        RETURNING tunnel_hostname`) as unknown as Array<{ tunnel_hostname: string }>;
      if (claimed.length > 0) {
        return { isLeader: true, tunnelHostname: claimed[0].tunnel_hostname };
      }
      const row = (await tx`
        SELECT tunnel_hostname FROM regions WHERE id = ${regionId}`) as unknown as Array<{
        tunnel_hostname: string;
      }>;
      return row.length > 0
        ? { isLeader: false, tunnelHostname: row[0].tunnel_hostname }
        : null;
    });
  }

  /** Publish one `SAMOGRAPH-WARNING` control line on a call's channel (#95 seam). */
  async function publishWarning(tx: SQL, callId: string, text: string, at: Date): Promise<void> {
    await publisher.publish(
      { type: "warning", call_id: callId, text, ts: canonicalTs(at) },
      tx,
    );
  }

  /** Bump `regions.last_probe_ts` when no status transition fired this tick. */
  async function bumpProbe(at: Date): Promise<void> {
    await sql`UPDATE regions SET last_probe_ts = ${tsLiteral(at)}::timestamptz WHERE id = ${regionId}`;
  }

  /**
   * Degrade the region exactly once per outage. The conditional UPDATE's
   * RETURNING is the cluster-wide "did I cause the transition" gate: a second
   * leader (or the same leader on the next failing tick) sees 0 rows and emits
   * nothing. Only on a real healthy→degraded transition do we flip
   * `ingest_degraded` for the region's IN_CALL calls and fan out the warning to
   * exactly those calls.
   */
  async function degrade(at: Date, cause: string): Promise<void> {
    const warning = tunnelUnreachableWarning(cause);
    await sql.begin(async (tx) => {
      const won = (await tx`
        UPDATE regions SET status = 'degraded', last_probe_ts = ${tsLiteral(at)}::timestamptz
         WHERE id = ${regionId} AND status <> 'degraded'
        RETURNING id`) as unknown as Array<{ id: string }>;
      if (won.length === 0) {
        await tx`UPDATE regions SET last_probe_ts = ${tsLiteral(at)}::timestamptz WHERE id = ${regionId}`;
        return;
      }
      const affected = (await tx`
        UPDATE calls SET ingest_degraded = true
         WHERE region = ${regionId} AND status = 'IN_CALL' AND ingest_degraded = false
        RETURNING id`) as unknown as Array<{ id: string }>;
      for (const r of affected) await publishWarning(tx, r.id, warning, at);
    });
  }

  /**
   * Recover the region exactly once. Mirror of {@link degrade}: the degraded→
   * healthy transition is the gate; on it we clear `ingest_degraded` for the
   * region's still-IN_CALL degraded calls (a call that went terminal mid-outage
   * was already cleared by the §5.2 trigger and is skipped) and fan out exactly
   * one recovered line to each.
   */
  async function recover(at: Date): Promise<void> {
    await sql.begin(async (tx) => {
      const won = (await tx`
        UPDATE regions SET status = 'healthy', last_probe_ts = ${tsLiteral(at)}::timestamptz
         WHERE id = ${regionId} AND status = 'degraded'
        RETURNING id`) as unknown as Array<{ id: string }>;
      if (won.length === 0) {
        await tx`UPDATE regions SET last_probe_ts = ${tsLiteral(at)}::timestamptz WHERE id = ${regionId}`;
        return;
      }
      const affected = (await tx`
        UPDATE calls SET ingest_degraded = false
         WHERE region = ${regionId} AND status = 'IN_CALL' AND ingest_degraded = true
        RETURNING id`) as unknown as Array<{ id: string }>;
      for (const r of affected) await publishWarning(tx, r.id, TUNNEL_RECOVERED_WARNING, at);
    });
  }

  async function tick(): Promise<void> {
    const at = now();

    const elected = await elect(at);
    leader = elected?.isLeader ?? false;
    if (!elected || !elected.isLeader) return; // missing region or a follower → nothing

    const probe = await probeTunnelHealth(toBaseUrl(elected.tunnelHostname), fetchFn, nonceFn);
    if (probe.ok) {
      consecutiveFailures = 0;
      await recover(at);
      return;
    }

    metrics.incTunnelProbeFailed(regionId);
    consecutiveFailures += 1;
    if (consecutiveFailures >= threshold) {
      await degrade(at, probe.ngrokErrorCode ?? "health check failed");
    } else {
      await bumpProbe(at);
    }
  }

  const scheduled = (deps.schedule ?? defaultSchedule)(
    () => void tick(),
    deps.intervalMs ?? SERVER_TUNNEL_PROBE_INTERVAL_MS,
  );

  return { tick, isLeader: () => leader, stop: () => scheduled.stop() };
}
