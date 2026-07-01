/**
 * @samograph/ingest — Bun/Hono HTTP service (SPEC §4.1).
 *
 * The `POST /webhook` authenticity front door (Recall signature + ingest_secret
 * verify + idempotent dispatch, §5.3) ships in `./webhook.ts`, the §5.4
 * transcript pipeline in `./transcriptPipeline.ts`, the §5.2 bot lifecycle in
 * `./botLifecycle.ts`, and the leader-elected multi-call tunnel watchdog
 * (§4.5/§4.6) in `./tunnelWatchdog.ts` — all re-exported here. This module also
 * keeps the Bun-native request handler whose GET /health echoes the
 * `samograph-health` marker so a regional cloudflared named tunnel can pass the
 * `/health` round-trip (§4.5, §8 exit).
 */
import { HEALTH_MARKER } from "../../src/server.ts";

// The §5.3 webhook authenticity front door (§6.2 #7).
export {
  createWebhookHandler,
  envWebhookSecretProvider,
  inMemoryWebhookSecretProvider,
  inMemoryWebhookMetrics,
  pgLookupCallByBotId,
  pgLookupCallByIngestSecret,
  WEBHOOK_MAX_BYTES,
  type CallIdentity,
  type Dispatch,
  type ValidatedEvent,
  type WebhookHandlerDeps,
  type WebhookLogger,
  type WebhookMetrics,
  type WebhookRejectReason,
  type WebhookSecretProvider,
} from "./webhook.ts";

// The §5.4 transcript pipeline: validated transcript.data → append-only
// `transcripts` row (monotonic seq) + per-call publish + `first_line_at` once +
// `transcript_lines_total{region}` (#78). `createTranscriptPipeline(...).dispatch`
// is the typed seam the webhook front door subscribes to.
export {
  createTranscriptPipeline,
  inMemoryTranscriptMetrics,
  splitCanonicalLine,
  type CanonicalLineParts,
  type TranscriptMetrics,
  type TranscriptPipeline,
  type TranscriptPipelineDeps,
} from "./transcriptPipeline.ts";

// The §5.2 bot-lifecycle: validated bot.status_change → calls.status transition
// (silent-call → IN_CALL), the §5.9 in-call recording disclosure (post once on
// in_call_recording only; leave on in_call_not_recording), per-call status
// control frames, audit entries, and the §6.2 #8 pickup-latency SLO (#79).
// `createBotLifecycle(...).dispatch` is the typed seam the webhook front door
// subscribes to alongside the transcript pipeline (compose with `composeDispatch`).
export {
  createBotLifecycle,
  composeDispatch,
  inMemoryBotWorker,
  inMemoryBotLifecycleMetrics,
  mapLifecycleCode,
  pickupLatencyPercentiles,
  DISCLOSURE_TEXT,
  SAMO_CALL_JOIN,
  SAMO_CALL_NOREC,
  SAMO_CALL_REMOVED,
  type BotLifecycle,
  type BotLifecycleDeps,
  type BotLifecycleMetrics,
  type BotWorkerPort,
  type LifecycleTransition,
  type PickupLatencyPercentiles,
} from "./botLifecycle.ts";

// The §4.5/§4.6 leader-elected tunnel watchdog: per-region probe on exactly one
// replica (advisory lock + 60 s lease), `ingest_degraded` fan-out + cluster-once
// `SAMOGRAPH-WARNING` lines via the publisher, `tunnel_probe_failed_total{region}`
// (§5.11), `SAMO-INGEST-DEGRADED` overlay (§5.16) (#81).
export {
  startRegionWatchdog,
  inMemoryWatchdogMetrics,
  SERVER_TUNNEL_PROBE_INTERVAL_MS,
  LEADER_LEASE_MS,
  TUNNEL_WATCHDOG_FAILURE_THRESHOLD,
  type RegionWatchdogDeps,
  type RegionWatchdogHandle,
  type WatchdogMetrics,
} from "./tunnelWatchdog.ts";

// The §4.1 `Bun.serve` ENTRYPOINT: webhook front door → composed dispatch
// (pipeline + lifecycle) → publisher, plus the watchdog scheduler driver (#99).
export {
  createIngestApp,
  startIngestServer,
  buildIngestDispatch,
  startRegionWatchdogs,
  PgListenNotifyPublisher,
  type IngestAppDeps,
  type IngestDispatchDeps,
  type IngestServerDeps,
  type IngestServerHandle,
  type WatchdogSchedulerDeps,
} from "./server.ts";

export const SERVICE_NAME = "ingest";

export function handler(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    // Same nonce + marker contract the CLI's `src/server.ts` /health uses, so the
    // §4.5 tunnel watchdog's `probeTunnelHealth` round-trip works unchanged and a
    // tunnel interstitial/error page can never pass as a healthy response.
    return Response.json({
      ok: true,
      nonce: url.searchParams.get("nonce") ?? "",
      marker: HEALTH_MARKER,
    });
  }
  return new Response("not found", { status: 404 });
}
