/**
 * Transcript replay / backfill reads (SPEC §5.5, §5.10) — RED STUB (#83).
 * Signatures only; the real RLS-scoped queries land in the GREEN commit.
 */
import type { SQL } from "bun";

export const DEFAULT_BACKFILL_LIMIT = 200;

export interface TranscriptLine {
  seq: number;
  ts: string;
  speaker: string | null;
  text: string;
}

export async function replayTranscripts(
  _tx: SQL,
  _callId: string,
  _sinceSeq: number,
): Promise<TranscriptLine[]> {
  throw new Error("RED: replayTranscripts not implemented (#83)");
}

export async function backfillRecent(
  _tx: SQL,
  _callId: string,
  _limit: number = DEFAULT_BACKFILL_LIMIT,
): Promise<TranscriptLine[]> {
  throw new Error("RED: backfillRecent not implemented (#83)");
}
