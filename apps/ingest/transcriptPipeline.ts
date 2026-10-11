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
import { normalizeTranscriptEventRow } from "../../packages/shared/transcript/index.ts";
import type {
  TranscriptLineFrame,
  TranscriptPublisher,
} from "../../packages/shared/transcript/publisher.ts";
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

/** Matches the canonical `YYYY-MM-DD HH:MM:SS` shape the normalizer emits. */
const CANONICAL_TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * A UTC `timestamptz` literal from the canonical `ts` — or `null` when the `ts`
 * is absent OR not a real, in-range calendar timestamp.
 *
 * **Why the validation matters (fail-safe / anti-DoS).** The INSERT/UPDATE cast
 * `COALESCE(<literal>::timestamptz, now())`, and Postgres evaluates the
 * `::timestamptz` cast BEFORE `COALESCE`. So a NON-EMPTY but invalid literal
 * (e.g. `0000-00-00 00:00:00` from a malformed-but-authenticated Recall payload —
 * `normalizeTranscriptLine` slices the absolute value verbatim and never throws)
 * would throw *inside the §93 dedup transaction* → rollback → webhook 500 →
 * Recall re-delivers the identical bytes forever (a hot poison-pill loop; the
 * line never persists). Returning `null` here makes `COALESCE` fall back to
 * `now()` instead, so the line always persists and the webhook returns 2xx.
 *
 * A VALID timestamp is preserved EXACTLY (the same `${ts}+00` as before); only a
 * value Postgres would reject is turned into `null`. Shape + field-range checks
 * reject out-of-range fields, and a UTC round-trip rejects impossible calendar
 * days (Feb 30, Apr 31, a non-leap Feb 29). Years `< 1` (no year 0) are rejected
 * too. This keeps the normalizer's never-throws guarantee true end-to-end.
 */
export function utcLiteral(ts: string): string | null {
  if (!ts) return null;
  const m = CANONICAL_TS.exec(ts);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // Reject impossible calendar days (e.g. Feb 30) via a UTC round-trip: a valid
  // (Y, M, D) survives Date.UTC unchanged; an overflowing one rolls into the
  // next month/day and fails the equality below. `setUTCFullYear` sidesteps the
  // JS quirk that maps years 0–99 to 1900–1999.
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  dt.setUTCFullYear(year);
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${ts}+00`;
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
    // §5.4 / §6.2 #1 — REUSE the shared normalizer, now carrying the line KIND
    // (#195). It returns marker-free structured columns for a `transcript.data`
    // utterance (kind='speech') OR an incoming `participant_events.chat_message`
    // (kind='chat'), and sanitizes every field (CR/LF collapse) so untrusted chat
    // text cannot forge a spoken line. `null` ⇒ not a transcript-bearing event.
    const row = normalizeTranscriptEventRow(validated.payload);
    if (row === null) return;

    const { kind, ts, speaker, text } = row;
    const tsLiteral = utcLiteral(ts);
    const callId = validated.callId;

    // Serialize per-call seq allocation within the tx (see the doc comment).
    await tx`SELECT pg_advisory_xact_lock(hashtext(${callId}))`;

    // Append-only insert allocating the next per-call seq atomically. `kind` is
    // persisted alongside the line (migration 0008, DEFAULT 'speech'); the
    // ` (chat)` marker is a render concern, never stored in `speaker`/`text`.
    const inserted = (await tx`
      INSERT INTO transcripts (call_id, seq, ts, speaker, text, kind)
      SELECT ${callId},
             COALESCE((SELECT MAX(seq) FROM transcripts WHERE call_id = ${callId}), 0) + 1,
             COALESCE(${tsLiteral}::timestamptz, now()),
             ${speaker}, ${text}, ${kind}
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
    // exactly-once on commit. A chat line carries `kind='chat'` so the ws-hub /
    // web render `Name (chat):`; a speech line omits `kind` (backward-compatible
    // wire shape). Then count the persisted line.
    const frame: TranscriptLineFrame = { type: "line", call_id: callId, seq, ts, speaker, text };
    if (kind === "chat") frame.kind = "chat";
    await deps.publisher.publish(frame, tx);
    deps.metrics.incTranscriptLines(region);
  }

  // Act on the transcript-bearing events (spoken audio + incoming meeting chat,
  // #195); `bot.status_change` flows to the lifecycle issue (#79), never here.
  const dispatch: Dispatch = (tx, validated) =>
    validated.kind === "transcript.data" || validated.kind === "participant_events.chat_message"
      ? handleTranscriptEvent(tx, validated)
      : undefined;

  return { handleTranscriptEvent, dispatch };
}
