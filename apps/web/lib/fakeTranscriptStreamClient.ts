/**
 * In-memory fake `TranscriptStreamClient` for component/route tests. Records
 * every `connect` (and the exact wire query a real client would build) so tests
 * assert the call shape, exposes driver methods to push scripted frames in order,
 * and serves seeded `fetchCallDetail`/`backfill` responses — all with no ws-hub.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 *
 * STUB: signatures only — behavioral bodies land in the GREEN commit.
 */
import { AppApiError, type CallStatus } from "./appApiClient.ts";
import type {
  CallDetail,
  CallRef,
  ConnectParams,
  StreamAuth,
  StreamEventHandler,
  StreamHandle,
  TranscriptLine,
  TranscriptStreamClient,
  TranscriptStreamEvent,
} from "./transcriptStreamClient.ts";

export interface RecordedConnect {
  callId: string;
  auth: StreamAuth;
  sinceSeq?: number;
}

export interface FailSpec {
  code: string;
  message: string;
  retryable?: boolean;
  status?: number;
}

export interface FakeTranscriptStreamClientOptions {
  /** Seed the value returned by `fetchCallDetail`. */
  callDetail?: CallDetail;
  /** Seed the lines returned by `backfill`. */
  backfillLines?: TranscriptLine[];
  /** When set, `fetchCallDetail` rejects with this typed error. */
  failFetchDetailWith?: FailSpec;
  /** When set, `backfill` rejects with this typed error. */
  failBackfillWith?: FailSpec;
}

export class FakeTranscriptStreamClient implements TranscriptStreamClient {
  /** Every `connect` call, in order. */
  readonly connects: RecordedConnect[] = [];
  /** The wire query (`since_seq`, `token`) a real client would build per connect. */
  readonly streamQueries: Array<Record<string, string>> = [];
  /** Every REST request, in order (path + method). */
  readonly requests: Array<{ path: string; method: "GET"; callId: string }> = [];

  private readonly options: FakeTranscriptStreamClientOptions;
  /** Open subscribers; a handle's `close()` flips its entry's `open` to false. */
  private readonly subscribers: Array<{
    onEvent: StreamEventHandler;
    open: boolean;
  }> = [];

  constructor(options: FakeTranscriptStreamClientOptions = {}) {
    this.options = options;
  }

  connect(params: ConnectParams, onEvent: StreamEventHandler): StreamHandle {
    this.connects.push({
      callId: params.callId,
      auth: params.auth,
      sinceSeq: params.sinceSeq,
    });
    // The exact query a real client would put on the WS URL (SPEC §5.5/§5.7):
    // `since_seq` for replay, `token` only for share auth (never for session).
    const query: Record<string, string> = {};
    if (params.sinceSeq !== undefined) query.since_seq = String(params.sinceSeq);
    if (params.auth.kind === "share") query.token = params.auth.token;
    this.streamQueries.push(query);

    const entry = { onEvent, open: true };
    this.subscribers.push(entry);
    return {
      close() {
        entry.open = false;
      },
    };
  }

  private deliver(event: TranscriptStreamEvent): void {
    for (const sub of this.subscribers) {
      if (sub.open) sub.onEvent(event);
    }
  }

  /** Driver: push a transcript line frame to all open subscribers. */
  emitLine(line: {
    seq: number;
    ts: string;
    speaker: string;
    text: string;
    final: boolean;
  }): void {
    this.deliver({ type: "line", ...line });
  }

  /** Driver: push a status frame. */
  emitStatus(status: CallStatus): void {
    this.deliver({ type: "status", status });
  }

  /** Driver: push a degraded-overlay frame. */
  emitDegraded(degraded: boolean): void {
    this.deliver({ type: "degraded", degraded });
  }

  /** Driver: push a gap control frame. */
  emitGap(sinceSeq: number, untilSeq: number): void {
    this.deliver({ type: "gap", sinceSeq, untilSeq });
  }

  /** Driver: push a closed frame. */
  emitClose(code?: number, reason?: string): void {
    this.deliver({ type: "closed", code, reason });
  }

  async fetchCallDetail(ref: CallRef): Promise<CallDetail> {
    this.requests.push({
      path: `/calls/${ref.callId}`,
      method: "GET",
      callId: ref.callId,
    });
    const fail = this.options.failFetchDetailWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    return (
      this.options.callDetail ?? { id: ref.callId, status: "IN_CALL", degraded: false }
    );
  }

  async backfill(ref: CallRef, sinceSeq: number): Promise<TranscriptLine[]> {
    this.requests.push({
      path: `/calls/${ref.callId}/transcript`,
      method: "GET",
      callId: ref.callId,
    });
    const fail = this.options.failBackfillWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    const lines = this.options.backfillLines ?? [];
    return lines.filter((l) => l.seq > sinceSeq).map((l) => ({ ...l }));
  }
}

export function createFakeTranscriptStreamClient(
  options?: FakeTranscriptStreamClientOptions,
): FakeTranscriptStreamClient {
  return new FakeTranscriptStreamClient(options);
}
