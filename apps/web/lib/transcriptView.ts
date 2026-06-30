/**
 * Pure render reducer for the per-call live transcript (SPEC §2, §5.4, §5.5, §5.10,
 * Stories 1 & 5). DOM-free and dependency-light — typechecked by the repo-wide
 * `tsc --noEmit` and exercised purely as data, with no server.
 *
 * The per-call page (issue #86) feeds the stream-client's events into
 * `transcriptReducer` and renders the resulting state. This module owns the
 * canonical `TranscriptLine` shape and the wire event union the page consumes;
 * the transport client (`transcriptStreamClient.ts`) re-exports them.
 *
 * STUB: signatures only — behavioral bodies land in the GREEN commit.
 */
import type { CallStatus } from "./appApiClient.ts";

/** Append-only transcript line, canonical shape (SPEC §4.2, §5.4). */
export interface TranscriptLine {
  /** Monotonic per-call sequence number (PK `(call_id, seq)`). */
  seq: number;
  /** Canonical timestamp string `YYYY-MM-DD HH:MM:SS` (byte-identical to the CLI). */
  ts: string;
  speaker: string;
  text: string;
}

/** The speaker label that marks a system tunnel/ingest warning line (§4.5). */
export const SAMOGRAPH_WARNING_SPEAKER = "SAMOGRAPH-WARNING";

/** Events the per-call page consumes from `/calls/:id/stream` (SPEC §5.5). */
export type TranscriptStreamEvent =
  | { type: "line"; seq: number; ts: string; speaker: string; text: string; final: boolean }
  | { type: "status"; status: CallStatus }
  | { type: "degraded"; degraded: boolean }
  | { type: "gap"; sinceSeq: number; untilSeq: number }
  | { type: "open" }
  | { type: "closed"; code?: number; reason?: string };

/**
 * Events the reducer accepts: every wire event PLUS a synthetic `backfill` the
 * page dispatches after fetching the missing `[sinceSeq, untilSeq]` range from
 * REST in response to a `gap` frame (SPEC §5.5 `?since_seq` replay).
 */
export type TranscriptViewEvent =
  | TranscriptStreamEvent
  | { type: "backfill"; lines: TranscriptLine[] };

export interface TranscriptViewState {
  /** Finalized lines, ascending `seq`, deduped (idempotent under replay). */
  lines: TranscriptLine[];
  /** The trailing in-progress (non-final) line, or null. */
  partial: TranscriptLine | null;
  status: CallStatus;
  /** `ingest_degraded` overlay (SPEC §5.10) — independent of `status`. */
  degraded: boolean;
  /** WS connection liveness (drives a reconnecting indicator). */
  connected: boolean;
  /** Pending backfill range from the last `gap` frame, or null. */
  pendingBackfill: { sinceSeq: number; untilSeq: number } | null;
}

const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>([
  "ENDED",
  "COULD_NOT_JOIN",
  "COULD_NOT_RECORD",
  "BOT_REMOVED",
]);

/** A terminal call status (SPEC §5.2): the call is over, degraded overlay resets. */
export function isTerminalStatus(status: CallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function initialTranscriptState(
  status: CallStatus = "PENDING",
): TranscriptViewState {
  return {
    lines: [],
    partial: null,
    status,
    degraded: false,
    connected: false,
    pendingBackfill: null,
  };
}

/** Render a line in the canonical CLI format `[ts] Speaker: text` (SPEC §5.4). */
export function formatRenderLine(_line: TranscriptLine): string {
  return "STUB";
}

/** Pure reducer: `(state, event) -> state` (SPEC §5.5). */
export function transcriptReducer(
  state: TranscriptViewState,
  _event: TranscriptViewEvent,
): TranscriptViewState {
  return state;
}
