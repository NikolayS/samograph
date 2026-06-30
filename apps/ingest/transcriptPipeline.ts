/**
 * Ingest transcript pipeline (SPEC §5.4, §5.2, §5.5, §5.10, §5.11; issue #78).
 *
 * The literal join between Sprint-1's pure normalizer and the live stream:
 *
 *   validated `transcript.data` event
 *     → `normalizeTranscriptLine(payload)` (§5.4 / §6.2 #1 — REUSED, not
 *        reimplemented; `null` for non-transcript/empty/partial → a no-op)
 *     → append-only `transcripts` row with a monotonic per-`call_id` `seq`
 *     → `calls.first_line_at` set ONCE (activation funnel §5.2; NOT IN_CALL)
 *     → publish `{call_id, seq, ts, speaker, text}` on the per-call channel
 *     → `transcript_lines_total{region}` ++ (§5.11)
 *
 * The handler runs INSIDE the §93 webhook dedup transaction (it is wired as the
 * `dispatch` seam): the dedup ledger makes a Recall re-delivery a no-op, so the
 * pipeline never double-appends. Within the tx an advisory lock serializes
 * `seq` allocation per call (see {@link createTranscriptPipeline}).
 */
import type { SQL } from "bun";
import { normalizeTranscriptLine } from "../../packages/shared/transcript/index.ts";
import type { TranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";
import type { Dispatch, ValidatedEvent } from "./webhook.ts";

/** Counter port for `transcript_lines_total{region}` (§5.11). */
export interface TranscriptMetrics {
  incTranscriptLines(region: string): void;
}

/** In-memory {@link TranscriptMetrics} for tests — exposes the per-region counts. */
export function inMemoryTranscriptMetrics(): TranscriptMetrics & {
  lines: Record<string, number>;
} {
  const lines: Record<string, number> = {};
  return {
    lines,
    incTranscriptLines(region) {
      lines[region] = (lines[region] ?? 0) + 1;
    },
  };
}

/** Structured columns split out of one canonical normalizer line. */
export interface CanonicalLineParts {
  /** `YYYY-MM-DD HH:MM:SS` (may be empty if the source word had no timestamp). */
  ts: string;
  speaker: string;
  text: string;
}

/**
 * Split a `normalizeTranscriptLine` output — `[YYYY-MM-DD HH:MM:SS] speaker:
 * utterance` — back into structured columns. This is the INVERSE of the
 * normalizer's format (its single source of truth), not a reimplementation of
 * it: `[${ts}] ${speaker}: ${text}` always re-renders the original line
 * byte-for-byte, so even a speaker containing `": "` round-trips losslessly
 * (only the speaker/text boundary shifts; the rendered line is identical).
 */
export function splitCanonicalLine(line: string): CanonicalLineParts {
  const match = /^\[([^\]]*)\] (.*)$/s.exec(line);
  if (!match) return { ts: "", speaker: "?", text: line };
  const ts = match[1];
  const rest = match[2];
  const sep = rest.indexOf(": ");
  if (sep === -1) return { ts, speaker: rest, text: "" };
  return { ts, speaker: rest.slice(0, sep), text: rest.slice(sep + 2) };
}

export interface TranscriptPipelineDeps {
  /** Per-call fan-out seam (in-memory fake in tests; LISTEN/NOTIFY in prod). */
  publisher: TranscriptPublisher;
  /** `transcript_lines_total{region}` counter (§5.11). */
  metrics: TranscriptMetrics;
}

export interface TranscriptPipeline {
  /**
   * Persist + publish ONE validated event. Must run inside the §93 dedup tx
   * (with the call's tenant context already set). A `null` normalizer result
   * (non-`transcript.data`, empty/partial words) is a no-op that never touches
   * the database, publishes nothing, and counts nothing.
   */
  handleTranscriptEvent(tx: SQL, validated: ValidatedEvent): Promise<void>;
  /** The {@link Dispatch} adapter the webhook front door (#93) subscribes to. */
  dispatch: Dispatch;
}

/** A UTC `timestamptz` literal from the canonical `ts`, or `null` if absent. */
function utcLiteral(ts: string): string | null {
  return ts ? `${ts}+00` : null;
}

/**
 * Build the transcript pipeline. The returned `handleTranscriptEvent` is also
 * exposed as a {@link Dispatch} (`dispatch`) that acts ONLY on `transcript.data`
 * — `bot.status_change` events flow to the lifecycle issue (#79), never here.
 *
 * **`seq` ordering guarantee.** Allocation reads `MAX(seq)+1` for the call. To
 * keep it strictly monotonic and gap-free under concurrent deliveries for the
 * SAME call, the handler first takes a transaction-scoped advisory lock keyed
 * on the `call_id`; it releases on commit/rollback, so a waiting delivery only
 * proceeds after the holder commits and (READ COMMITTED) then sees its row in
 * the `MAX(seq)` read. Re-delivery of the same event never reaches here (deduped
 * at the webhook, #93), so this never double-appends.
 */
export function createTranscriptPipeline(
  deps: TranscriptPipelineDeps,
): TranscriptPipeline {
  async function handleTranscriptEvent(
    tx: SQL,
    validated: ValidatedEvent,
  ): Promise<void> {
    // §5.4 / §6.2 #1 — REUSE the normalizer. `null` ⇒ not a transcript line.
    const line = normalizeTranscriptLine(validated.payload);
    if (line === null) return;

    const { ts, speaker, text } = splitCanonicalLine(line);
    const tsLiteral = utcLiteral(ts);
    const callId = validated.callId;

    // Serialize per-call seq allocation within the tx (see the doc comment).
    await tx`SELECT pg_advisory_xact_lock(hashtext(${callId}))`;

    // Append-only insert allocating the next per-call seq atomically.
    const inserted = (await tx`
      INSERT INTO transcripts (call_id, seq, ts, speaker, text)
      SELECT ${callId},
             COALESCE((SELECT MAX(seq) FROM transcripts WHERE call_id = ${callId}), 0) + 1,
             COALESCE(${tsLiteral}::timestamptz, now()),
             ${speaker}, ${text}
      RETURNING seq`) as unknown as Array<{ seq: number | bigint }>;
    const seq = Number(inserted[0].seq);

    // First-line latency for the activation funnel (§5.2): set ONCE, never
    // overwritten, and explicitly NOT a status driver (lifecycle owns IN_CALL).
    await tx`
      UPDATE calls SET first_line_at = COALESCE(${tsLiteral}::timestamptz, now())
      WHERE id = ${callId} AND first_line_at IS NULL`;

    // Region label for `transcript_lines_total{region}` (§5.11), read under RLS.
    const regionRows = (await tx`
      SELECT region FROM calls WHERE id = ${callId}`) as unknown as Array<{
      region: string | null;
    }>;
    const region = regionRows[0]?.region ?? "unknown";

    // Publish on the per-call channel, on the SAME tx so a LISTEN/NOTIFY impl is
    // exactly-once on commit. Then count the persisted line.
    await deps.publisher.publish(
      { type: "line", call_id: callId, seq, ts, speaker, text },
      tx,
    );
    deps.metrics.incTranscriptLines(region);
  }

  const dispatch: Dispatch = (tx, validated) =>
    validated.kind === "transcript.data"
      ? handleTranscriptEvent(tx, validated)
      : undefined;

  return { handleTranscriptEvent, dispatch };
}
