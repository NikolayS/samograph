/**
 * Typed stream-client seam for the per-call live transcript (SPEC §4.1, §5.5,
 * Stories 1, 2 & 5). The per-call page subscribes to `/calls/:id/stream` only
 * through this interface, so it is testable against an in-memory fake
 * (`fakeTranscriptStreamClient.ts`) with NO ws-hub / backend — making this issue
 * independent of the backend merge order.
 *
 * Auth is either the owner's `session` cookie (derived `read` scope, §5.7) or a
 * `share` token (persisted `share` scope, §5.7); `sinceSeq` replays missed lines
 * from Postgres on reconnect (`?since_seq`, §5.5). REST helpers cover the
 * call-detail fetch and the gap-driven backfill.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 */
import { AppApiError, type CallStatus } from "./appApiClient.ts";
import type { TranscriptLine, TranscriptStreamEvent } from "./transcriptView.ts";

// Re-export the data + event types so consumers can import them from the client.
export type { TranscriptLine, TranscriptStreamEvent };

/** Owner session auth — derives the `read` scope at the tenancy gate (§5.7). */
export interface SessionAuth {
  kind: "session";
}
/** Anonymous share-link auth — carries the persisted `share` token (§5.7). */
export interface ShareAuth {
  kind: "share";
  token: string;
}
export type StreamAuth = SessionAuth | ShareAuth;

/** A reference to one call + how the caller is authorized to it. */
export interface CallRef {
  callId: string;
  auth: StreamAuth;
}

/** `connect` input: a call ref plus an optional replay cursor (§5.5). */
export type ConnectParams = CallRef & { sinceSeq?: number };

/** Call header read by the page on load before/around the WS stream (§5.2/§5.10). */
export interface CallDetail {
  id: string;
  status: CallStatus;
  /** `ingest_degraded` overlay (§5.10). */
  degraded: boolean;
}

export type StreamEventHandler = (event: TranscriptStreamEvent) => void;

/** A live subscription; `close()` tears down the underlying WebSocket. */
export interface StreamHandle {
  close(): void;
}

export interface TranscriptStreamClient {
  /** Subscribe to `/calls/:id/stream`; events arrive via `onEvent`. */
  connect(params: ConnectParams, onEvent: StreamEventHandler): StreamHandle;
  /** `GET /calls/:id` — the call header (status + degraded overlay). */
  fetchCallDetail(ref: CallRef): Promise<CallDetail>;
  /** `GET /calls/:id/transcript?since_seq=…` — replay the missing range (§5.5). */
  backfill(ref: CallRef, sinceSeq: number): Promise<TranscriptLine[]>;
}

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
}

/**
 * Real HTTP/WS client used by the Next.js per-call page. The ws-hub / REST
 * backend is the backend track; this is the thin seam that lights up once it
 * exists. Exercised in this issue only through the fake.
 *
 * STUB: REST bodies are placeholders — implemented in the GREEN commit.
 */
export function createHttpTranscriptStreamClient(
  _baseUrl = "",
  _wsBaseUrl = "",
): TranscriptStreamClient {
  return {
    connect(_params, _onEvent) {
      return { close() {} };
    },
    async fetchCallDetail(_ref) {
      throw new AppApiError("SAMO-STUB", "not implemented", false);
    },
    async backfill(_ref, _sinceSeq) {
      throw new AppApiError("SAMO-STUB", "not implemented", false);
    },
  };
}
