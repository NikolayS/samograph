/**
 * @samograph/ingest — Bun/Hono HTTP service (SPEC §4.1).
 *
 * The `POST /webhook` authenticity front door (Recall signature + ingest_secret
 * verify + idempotent dispatch, §5.3) ships in `./webhook.ts` and is re-exported
 * here. The normalizer, Postgres transcript persistence, fan-out publish, and
 * the leader-elected tunnel watchdog land in the remaining call-path Sprint-2
 * issues (#78 / #79). This module also keeps the Bun-native request handler
 * whose GET /health echoes the `samograph-health` marker so a regional
 * cloudflared named tunnel can pass the `/health` round-trip (§4.5, §8 exit).
 */
import { HEALTH_MARKER } from "../../src/server.ts";

// The §5.3 webhook authenticity front door (§6.2 #7).
export {
  createWebhookHandler,
  envWebhookSecretProvider,
  inMemoryWebhookSecretProvider,
  inMemoryWebhookMetrics,
  pgLookupCallByBotId,
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
