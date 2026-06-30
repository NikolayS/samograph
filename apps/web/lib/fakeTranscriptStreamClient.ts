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

  constructor(options: FakeTranscriptStreamClientOptions = {}) {
    this.options = options;
  }

  connect(_params: ConnectParams, _onEvent: StreamEventHandler): StreamHandle {
    return { close() {} };
  }

  /** Driver: push a transcript line frame to all open subscribers. */
  emitLine(_line: {
    seq: number;
    ts: string;
    speaker: string;
    text: string;
    final: boolean;
  }): void {}

  /** Driver: push a status frame. */
  emitStatus(_status: CallStatus): void {}

  /** Driver: push a degraded-overlay frame. */
  emitDegraded(_degraded: boolean): void {}

  /** Driver: push a gap control frame. */
  emitGap(_sinceSeq: number, _untilSeq: number): void {}

  /** Driver: push a closed frame (and stop further delivery to that conn). */
  emitClose(_code?: number, _reason?: string): void {}

  async fetchCallDetail(_ref: CallRef): Promise<CallDetail> {
    throw new AppApiError("SAMO-STUB", "not implemented", false);
  }

  async backfill(_ref: CallRef, _sinceSeq: number): Promise<TranscriptLine[]> {
    throw new AppApiError("SAMO-STUB", "not implemented", false);
  }
}

export function createFakeTranscriptStreamClient(
  options?: FakeTranscriptStreamClientOptions,
): FakeTranscriptStreamClient {
  return new FakeTranscriptStreamClient(options);
}
