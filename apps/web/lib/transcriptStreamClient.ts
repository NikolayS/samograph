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

async function throwTyped(res: Response, fallbackCode: string): Promise<never> {
  let parsed: ApiErrorBody = {};
  try {
    parsed = (await res.json()) as ApiErrorBody;
  } catch {
    parsed = {};
  }
  const code = typeof parsed.code === "string" ? parsed.code : fallbackCode;
  const message =
    typeof parsed.message === "string" ? parsed.message : "Request failed.";
  const retryable = parsed.retryable === true;
  throw new AppApiError(code, message, retryable, res.status);
}

/** Append the auth/replay query a request needs (share token, `?since_seq`). */
function queryFor(auth: StreamAuth, sinceSeq?: number): string {
  const params = new URLSearchParams();
  if (sinceSeq !== undefined) params.set("since_seq", String(sinceSeq));
  if (auth.kind === "share") params.set("token", auth.token);
  const q = params.toString();
  return q ? `?${q}` : "";
}

/**
 * Real HTTP/WS client used by the Next.js per-call page. The ws-hub / REST
 * backend is the backend track; this is the thin seam that lights up once it
 * exists. Exercised in this issue only through the fake.
 */
export function createHttpTranscriptStreamClient(
  baseUrl = "",
  wsBaseUrl = "",
): TranscriptStreamClient {
  return {
    connect(params, onEvent) {
      const url = `${wsBaseUrl}/calls/${encodeURIComponent(params.callId)}/stream${queryFor(
        params.auth,
        params.sinceSeq,
      )}`;
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => onEvent({ type: "open" }));
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          onEvent(JSON.parse(String(ev.data)) as TranscriptStreamEvent);
        } catch {
          // Drop unparseable frames rather than crash the stream.
        }
      });
      ws.addEventListener("close", (ev: CloseEvent) =>
        onEvent({ type: "closed", code: ev.code, reason: ev.reason }),
      );
      return {
        close() {
          ws.close();
        },
      };
    },
    async fetchCallDetail(ref) {
      const res = await fetch(
        `${baseUrl}/calls/${encodeURIComponent(ref.callId)}${queryFor(ref.auth)}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      const data = (await res.json()) as {
        id?: unknown;
        status?: unknown;
        ingest_degraded?: unknown;
      };
      return {
        id: typeof data.id === "string" ? data.id : ref.callId,
        status: data.status as CallStatus,
        degraded: data.ingest_degraded === true,
      };
    },
    async backfill(ref, sinceSeq) {
      const res = await fetch(
        `${baseUrl}/calls/${encodeURIComponent(ref.callId)}/transcript${queryFor(
          ref.auth,
          sinceSeq,
        )}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      const data = (await res.json()) as {
        lines?: Array<{ seq?: unknown; ts?: unknown; speaker?: unknown; text?: unknown }>;
      };
      const rows = Array.isArray(data.lines) ? data.lines : [];
      return rows
        .filter(
          (r): r is { seq: number; ts: string; speaker: string; text: string } =>
            typeof r.seq === "number" &&
            typeof r.ts === "string" &&
            typeof r.speaker === "string" &&
            typeof r.text === "string",
        )
        .map((r) => ({ seq: r.seq, ts: r.ts, speaker: r.speaker, text: r.text }));
    },
  };
}
