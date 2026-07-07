/**
 * Transcript replay / backfill reads for the WS stream (SPEC §5.5, §5.10).
 *
 * The `transcripts` table is append-only with PK `(call_id, seq)` and carries
 * ONLY finalized lines — partials are never persisted (§5.5: "drop partials,
 * never finals"). These two RLS-scoped reads feed the WS upgrade and the REST
 * gap-resync endpoint:
 *
 *   • {@link backfillRecent} — the last ~200 finalized lines of a call, returned
 *     ascending. A fresh subscriber gets recent context before live frames.
 *   • {@link replayTranscripts} — given a client's last-seen `since_seq`, the
 *     EXACT missing tail `seq > since_seq`, ascending. The reconnect/gap-resync
 *     path: no duplicate of the boundary `seq`, no gap.
 *
 * Both run on the request's transaction AFTER the tenancy gate (§5.6) has set
 * `app.tenant_id`, so RLS scopes every row to the call's tenant: `transcripts`
 * has no `tenant_id` column and is filtered through its call's tenant (§5.10).
 * A query for another tenant's call therefore returns ZERO rows.
 */
import type { SQL } from "bun";

/** Default backfill window: the most recent finalized lines (SPEC §5.5). */
export const DEFAULT_BACKFILL_LIMIT = 200;

/** One finalized transcript line on the wire / in a backfill response. */
export interface TranscriptLine {
  seq: number;
  ts: string;
  speaker: string | null;
  text: string;
}

/** A raw `transcripts` row as returned by the driver. */
interface TranscriptRow {
  seq: number | bigint | string;
  ts: Date | string;
  speaker: string | null;
  text: string;
}

/** Normalize a driver row into a JSON-stable {@link TranscriptLine}. */
function mapRow(row: TranscriptRow): TranscriptLine {
  return {
    // `seq` is a Postgres bigint; coerce to a JS number (call seqs are well
    // within Number.MAX_SAFE_INTEGER) so the wire shape is plain JSON.
    seq: Number(row.seq),
    ts: new Date(row.ts).toISOString(),
    speaker: row.speaker ?? null,
    text: row.text,
  };
}

/**
 * Replay the EXACT missing tail after `sinceSeq`: every finalized line with
 * `seq > sinceSeq`, ascending. The boundary `seq === sinceSeq` is the client's
 * last-known line and is deliberately excluded (no duplicate). `sinceSeq >= max`
 * yields an empty array — not an error. RLS-scoped: a foreign call returns none.
 */
export async function replayTranscripts(
  tx: SQL,
  callId: string,
  sinceSeq: number,
): Promise<TranscriptLine[]> {
  const rows = (await tx`
    SELECT seq, ts, speaker, text
    FROM transcripts
    WHERE call_id = ${callId} AND seq > ${sinceSeq}
    ORDER BY seq ASC`) as unknown as TranscriptRow[];
  return rows.map(mapRow);
}

/**
 * The WHOLE finalized transcript of a call, ascending by `seq` — every line,
 * no window (Story 3: the downloadable transcript is the full call, not the
 * ~200-line backfill tail). RLS-scoped like the other reads: a foreign call
 * returns nothing. Runs after the tenancy gate has set `app.tenant_id`.
 */
export async function fetchFullTranscript(
  tx: SQL,
  callId: string,
): Promise<TranscriptLine[]> {
  const rows = (await tx`
    SELECT seq, ts, speaker, text
    FROM transcripts
    WHERE call_id = ${callId}
    ORDER BY seq ASC`) as unknown as TranscriptRow[];
  return rows.map(mapRow);
}

/**
 * The last `limit` finalized lines of a call, returned ASCENDING (oldest first)
 * so they can be streamed in delivery order before live frames resume. Reads the
 * newest `limit` by `seq DESC` then re-sorts ascending. RLS-scoped.
 */
export async function backfillRecent(
  tx: SQL,
  callId: string,
  limit: number = DEFAULT_BACKFILL_LIMIT,
): Promise<TranscriptLine[]> {
  const rows = (await tx`
    SELECT seq, ts, speaker, text
    FROM (
      SELECT seq, ts, speaker, text
      FROM transcripts
      WHERE call_id = ${callId}
      ORDER BY seq DESC
      LIMIT ${limit}
    ) recent
    ORDER BY seq ASC`) as unknown as TranscriptRow[];
  return rows.map(mapRow);
}
