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
import { formatTranscriptLineWithKind } from "../../../packages/shared/transcript/index.ts";
import type { CallStatus } from "./appApiClient.ts";

/** Whether a line is spoken audio ('speech') or a typed meeting-chat message ('chat', #195). */
export type TranscriptLineKind = "speech" | "chat";

/** Append-only transcript line, canonical shape (SPEC §4.2, §5.4). */
export interface TranscriptLine {
  /** Monotonic per-call sequence number (PK `(call_id, seq)`). */
  seq: number;
  /** Canonical timestamp string `YYYY-MM-DD HH:MM:SS` (byte-identical to the CLI). */
  ts: string;
  speaker: string;
  text: string;
  /**
   * Line kind (#195): a `chat` line renders `[ts] speaker (chat): text`. OMITTED
   * for a spoken line so the shape stays byte-identical to pre-#195.
   */
  kind?: TranscriptLineKind;
}

/** The speaker label that marks a system tunnel/ingest warning line (§4.5). */
export const SAMOGRAPH_WARNING_SPEAKER = "SAMOGRAPH-WARNING";

/** Events the per-call page consumes from `/calls/:id/stream` (SPEC §5.5). */
export type TranscriptStreamEvent =
  | { type: "line"; seq: number; ts: string; speaker: string; text: string; final: boolean; kind?: TranscriptLineKind }
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

/**
 * Render a line in the canonical CLI format `[ts] Speaker: text` (SPEC §5.4), or
 * `[ts] Speaker (chat): text` for a chat line (#195). Delegates to the ONE shared
 * formatter ({@link formatTranscriptLineWithKind}) so the ` (chat)` marker has a
 * single source of truth across the CLI, the hosted ingest, and this web renderer.
 */
export function formatRenderLine(line: TranscriptLine): string {
  return formatTranscriptLineWithKind({
    ts: line.ts,
    speaker: line.speaker,
    text: line.text,
    kind: line.kind,
  });
}

function lineFromEvent(event: {
  seq: number;
  ts: string;
  speaker: string;
  text: string;
  kind?: TranscriptLineKind;
}): TranscriptLine {
  const line: TranscriptLine = { seq: event.seq, ts: event.ts, speaker: event.speaker, text: event.text };
  // Only a chat line carries `kind` (#195); a speech line has no `kind` key so
  // its shape stays byte-identical to pre-#195.
  if (event.kind === "chat") line.kind = "chat";
  return line;
}

/**
 * Insert a finalized line by `seq`, ascending. Re-applying an already-present
 * `seq` is a no-op (idempotent under WS replay / backfill overlap, SPEC §5.5):
 * the first occurrence wins and no duplicate row is created.
 */
function upsertLine(
  lines: readonly TranscriptLine[],
  line: TranscriptLine,
): TranscriptLine[] {
  if (lines.some((l) => l.seq === line.seq)) return lines as TranscriptLine[];
  const next = [...lines, line];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

/** Pure reducer: `(state, event) -> state` (SPEC §5.5). */
export function transcriptReducer(
  state: TranscriptViewState,
  event: TranscriptViewEvent,
): TranscriptViewState {
  switch (event.type) {
    case "open":
      return { ...state, connected: true };

    case "closed":
      return { ...state, connected: false };

    case "status": {
      // A terminal transition resets the degraded overlay (SPEC §5.2, §5.10).
      const degraded = isTerminalStatus(event.status) ? false : state.degraded;
      return { ...state, status: event.status, degraded };
    }

    case "degraded":
      // `ingest_degraded` overlay — independent of the warning-line driver.
      return { ...state, degraded: event.degraded };

    case "gap":
      return {
        ...state,
        pendingBackfill: { sinceSeq: event.sinceSeq, untilSeq: event.untilSeq },
      };

    case "backfill": {
      let lines = state.lines;
      for (const l of event.lines) lines = upsertLine(lines, l);
      return { ...state, lines, pendingBackfill: null };
    }

    case "line": {
      const line = lineFromEvent(event);

      // SAMOGRAPH-WARNING lines are system notes: appended inline in seq order
      // AND a second, independent driver of the degraded overlay (Story 5).
      // They never disturb the in-progress utterance partial.
      if (event.speaker === SAMOGRAPH_WARNING_SPEAKER) {
        let degraded = state.degraded;
        if (event.text.includes("unreachable")) degraded = true;
        else if (event.text.includes("recovered")) degraded = false;
        return { ...state, lines: upsertLine(state.lines, line), degraded };
      }

      // A non-final line is the trailing partial — replace whatever was held.
      if (!event.final) {
        return { ...state, partial: line };
      }

      // A final line is appended (deduped); it clears only the partial it
      // finalizes (same seq), so a replayed final can't clobber a newer partial.
      const partial =
        state.partial && state.partial.seq === line.seq ? null : state.partial;
      return { ...state, lines: upsertLine(state.lines, line), partial };
    }

    default:
      return state;
  }
}
