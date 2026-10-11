/**
 * OUTAGE watchdog → LIVE page BRIDGE (SPEC §3 Story 5, §4.5, §4.6, §5.10; the
 * production caller `startRegionWatchdogs` never had).
 *
 * The leader-elected region watchdog (`apps/ingest/tunnelWatchdog.ts`, #81) was
 * dead code in the deployed live transport: nothing ran it, so a real tunnel /
 * ingest outage silently froze the transcript. This module wires it into the
 * composed ingest + ws-hub process (`dev-live-server.ts`, #99) around the SAME
 * in-process Hub the per-call pages stream from:
 *
 *   1. `ensureRegion` seeds/refreshes the region row (`us-east` in v1, §4.7)
 *      with the probe target — `PUBLIC_WEBHOOK_BASE`, whose `/health` fronts
 *      THIS process's ingest and returns the byte-exact §4.5 marker.
 *   2. The REAL `startRegionWatchdog` runs unchanged (advisory-lock leader
 *      election §4.6 — a single process trivially leads; the once-per-outage
 *      `regions.status` latch is what keeps flapping from spamming): 2
 *      consecutive failed probes → region `degraded` + `calls.ingest_degraded
 *      = true` for every IN_CALL call in the region + ONE warning per call;
 *      recovery reverses all three.
 *   3. Each `SAMOGRAPH-WARNING` control frame is PERSISTED as a transcript
 *      line INSIDE the watchdog's own transaction (same per-call advisory lock
 *      + `MAX(seq)+1` allocation as the §5.4 pipeline, so it can never race a
 *      concurrent webhook line). A persisted line has a real `seq`, so it
 *      rides the EXISTING line path end-to-end: after the tx commits the
 *      buffered `{call_id, seq}` signal is handed to the fan-in, re-hydrated
 *      under RLS, `hub.publish`ed, and FLUSH-ON-PUBLISH pushes it to every
 *      open page live — where the reducer appends the line AND flips the
 *      degraded overlay (Story 5). A page that reconnects backfills it (§5.5).
 *
 * Delivering after commit mirrors the webhook path in `liveBridge.ts` (the
 * in-process analog of `pg_notify`'s commit-gated delivery): a rolled-back
 * degrade publishes nothing. The probe `fetch`, clock, and scheduler are
 * injected so tests drive `tick()` with a fake /health and a virtual clock.
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { HealthFetch } from "../../src/server.ts";
import type {
  TranscriptPublisher,
  TranscriptSignal,
} from "../../packages/shared/transcript/publisher.ts";
import { encodeSignal } from "../../packages/shared/transcript/publisher.ts";
import {
  startRegionWatchdog,
  inMemoryWatchdogMetrics,
  SERVER_TUNNEL_PROBE_INTERVAL_MS,
  type WatchdogMetrics,
} from "../ingest/tunnelWatchdog.ts";
import type { FanIn } from "./fanIn.ts";

/**
 * The speaker label a persisted watchdog warning line carries — MUST stay
 * byte-identical to `SAMOGRAPH_WARNING_SPEAKER` in `apps/web/lib/transcriptView.ts`
 * (the reducer keys the degraded overlay on it, Story 5).
 */
export const WARNING_SPEAKER = "SAMOGRAPH-WARNING";

/**
 * Seed the region row the watchdog elects/probes on (§4.7), idempotently. On an
 * existing row only the probe target (`tunnel_hostname`) is refreshed — a
 * restart mid-outage MUST NOT reset a `degraded` status back to healthy (that
 * would re-fire the warning on the next outage tick and lose the recovery line).
 */
export async function ensureRegion(
  sql: SQL,
  regionId: string,
  tunnelHostname: string,
): Promise<void> {
  await sql`
    INSERT INTO regions (id, tunnel_hostname, status)
    VALUES (${regionId}, ${tunnelHostname}, 'healthy')
    ON CONFLICT (id) DO UPDATE SET tunnel_hostname = EXCLUDED.tunnel_hostname`;
}

/** Collaborators for {@link startLiveWatchdogBridge}. */
export interface LiveWatchdogDeps {
  /** Privileged infra connection (bypasses RLS: `regions` + cross-tenant `calls`). */
  sql: SQL;
  /** The live stack's fan-in — delivery lands on the SAME Hub open pages stream from. */
  fanIn: FanIn;
  /** The region this process watches (`us-east` in v1, §4.7). */
  regionId: string;
  /** Probe base: this env's own public ingress (`resolveProbeBase` — `BASE_URL`
   * over `PUBLIC_WEBHOOK_BASE`, #206); its `/health` returns the §4.5 marker. */
  probeBase: string;
  /** Leader identity persisted in `regions`; defaults to a fresh UUID. */
  replicaId?: string;
  /** `tunnel_probe_failed_total{region}` counter (§5.11); in-memory default. */
  metrics?: WatchdogMetrics;
  /** Injected health probe (no real network in tests); defaults to global `fetch`. */
  fetch?: HealthFetch;
  /** Injected clock; defaults to the wall clock. */
  now?: () => Date;
  /** Probe interval (defaults to {@link SERVER_TUNNEL_PROBE_INTERVAL_MS}). */
  intervalMs?: number;
  /** Scheduler seam (defaults to an unref'd `setInterval`); tests drive `tick()`. */
  schedule?: (fn: () => void, ms: number) => { stop(): void };
  /** Consecutive failures before degrading (defaults to the watchdog's 2). */
  failureThreshold?: number;
}

export interface LiveWatchdogHandle {
  /** Run ONE probe cycle + deliver its warnings to the Hub. The schedule calls it. */
  tick(): Promise<void>;
  /** Whether this replica held leadership as of its last {@link tick}. */
  isLeader(): boolean;
  stop(): void;
}

function defaultSchedule(fn: () => void, ms: number): { stop(): void } {
  const timer = setInterval(fn, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * A {@link TranscriptPublisher} that persists each watchdog `warning` frame as
 * a `SAMOGRAPH-WARNING` transcript line on the watchdog's OWN transaction and
 * buffers the resulting `{call_id, seq}` line signal for after-commit delivery.
 * Line frames (none are expected from the watchdog) buffer their signal as-is.
 */
function createPersistingWarningPublisher(buffer: TranscriptSignal[]): TranscriptPublisher {
  return {
    async publish(frame, exec) {
      if (frame.type !== "warning" || !exec || typeof frame.text !== "string") {
        buffer.push(encodeSignal(frame));
        return;
      }
      const callId = frame.call_id;
      // Canonical `YYYY-MM-DD HH:MM:SS` from the watchdog → UTC literal (§5.4).
      const tsLiteral = typeof frame.ts === "string" && frame.ts ? `${frame.ts}+00` : null;
      // Same serialization as the §5.4 pipeline: the per-call advisory xact lock
      // makes the MAX(seq)+1 allocation race-free against concurrent webhook lines.
      await exec`SELECT pg_advisory_xact_lock(hashtext(${callId}))`;
      const inserted = (await exec`
        INSERT INTO transcripts (call_id, seq, ts, speaker, text)
        SELECT ${callId},
               COALESCE((SELECT MAX(seq) FROM transcripts WHERE call_id = ${callId}), 0) + 1,
               COALESCE(${tsLiteral}::timestamptz, now()),
               ${WARNING_SPEAKER}, ${frame.text}
        RETURNING seq`) as unknown as Array<{ seq: number | bigint }>;
      buffer.push({ k: "line", call_id: callId, seq: Number(inserted[0].seq) });
    },
  };
}

/**
 * Wire the region watchdog into the composed live transport: seed the region,
 * start the REAL `startRegionWatchdog` with a persisting publisher, and after
 * each tick (i.e. after its transaction committed) deliver the buffered line
 * signals through the fan-in onto the shared Hub — so an open per-call page
 * receives the outage/recovery line live (Story 5).
 */
export async function startLiveWatchdogBridge(
  deps: LiveWatchdogDeps,
): Promise<LiveWatchdogHandle> {
  await ensureRegion(deps.sql, deps.regionId, deps.probeBase);

  const buffer: TranscriptSignal[] = [];
  const inner = startRegionWatchdog({
    sql: deps.sql,
    regionId: deps.regionId,
    replicaId: deps.replicaId ?? `live-${randomUUID()}`,
    publisher: createPersistingWarningPublisher(buffer),
    metrics: deps.metrics ?? inMemoryWatchdogMetrics(),
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    now: deps.now ?? (() => new Date()),
    failureThreshold: deps.failureThreshold,
    // The bridge owns scheduling: delivery MUST follow each tick's commit.
    schedule: () => ({ stop() {} }),
  });

  async function tick(): Promise<void> {
    await inner.tick();
    // The watchdog tx committed inside tick(); now (and only now) fan the
    // persisted warning lines onto the Hub — the liveBridge commit-gate analog.
    for (const signal of buffer.splice(0)) await deps.fanIn.deliver(signal);
  }

  const scheduled = (deps.schedule ?? defaultSchedule)(
    () => void tick(),
    deps.intervalMs ?? SERVER_TUNNEL_PROBE_INTERVAL_MS,
  );

  return {
    tick,
    isLeader: () => inner.isLeader(),
    stop() {
      scheduled.stop();
      inner.stop();
    },
  };
}
