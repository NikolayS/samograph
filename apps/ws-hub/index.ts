/**
 * @samograph/ws-hub — Bun/Hono HTTP + WS service (SPEC §4.1).
 *
 * The transport-agnostic fan-out CORE — per-`call_id` pub/sub, a bounded
 * per-subscriber outbound queue (256 msgs / 512 KB), drop-oldest + a single
 * gap frame (§5.5, §6.2 #3, §5.11) — lives in ./hub.ts. Layered on top:
 *   • ./stream.ts — the `GET /calls/:id/stream` WS upgrade: authorize via the
 *     single tenancy gate (no cache), then backfill-then-live with `?since_seq`
 *     replay and a revoke-closes-the-socket recheck (§5.5/§5.6/§6.2 #3/#4).
 *   • ./transcript.ts — the RLS-scoped replay/backfill reads against the
 *     append-only `transcripts` table (§5.10).
 *   • ./transcript-http.ts — `GET /calls/:id/transcript?since_seq=N`, the REST
 *     gap-resync endpoint the client uses after a hub gap frame.
 * The publisher-latency SLO benchmark (§6.2 #3) is #87 and is NOT here. This
 * entrypoint still exposes a Bun-native /health handler exercised by CI.
 */
export {
  Hub,
  Subscriber,
  frameBytes,
  MAX_QUEUE_MESSAGES,
  MAX_QUEUE_BYTES,
  type DataFrame,
  type GapFrame,
  type OutboundFrame,
} from "./hub.ts";

export {
  prepareStream,
  parseStreamRequest,
  openStream,
  StreamConnection,
  RECHECK_INTERVAL_MS,
  type StreamScope,
  type StreamSocket,
  type StreamCredentials,
  type StreamAuthDeps,
  type PrepareStreamResult,
  type ParsedStreamRequest,
  type OpenStreamDeps,
  type StreamConnectionInit,
} from "./stream.ts";

export {
  replayTranscripts,
  backfillRecent,
  DEFAULT_BACKFILL_LIMIT,
  type TranscriptLine,
} from "./transcript.ts";

export {
  createTranscriptHandler,
  type TranscriptHandlerDeps,
  type TranscriptResponseBody,
} from "./transcript-http.ts";

export {
  readCallCredentials,
  parseSinceSeq,
  type CallCredentials,
} from "./request.ts";

export const SERVICE_NAME = "ws-hub";

export function handler(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok", { status: 200 });
  return new Response("not found", { status: 404 });
}
