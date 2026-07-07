/**
 * Canonical transcript normalizer (SPEC §5.4, §6.2 #1).
 *
 * A PURE function — no I/O, no clock, no globals — that turns a Recall
 * `transcript.data` webhook payload into the canonical transcript line
 *
 *     [YYYY-MM-DD HH:MM:SS] Speaker: utterance
 *
 * (the on-disk / wire framing appends a trailing "\n"; the caller owns that,
 * exactly as the CLI's writer does `line + "\n"`). The semantics are
 * byte-identical to the CLI `src/transcript.ts:formatTranscriptLine`, which now
 * re-exports this function so the format has a single source of truth and can
 * never drift between the CLI and the hosted ingest service (SPEC §4.2, §5.4).
 *
 * Extracted from the CLI for #39; TDD'd in `./normalizer.test.ts`.
 */

interface NormalizerWord {
  text?: string;
  start_timestamp?: { absolute?: string };
}

interface TranscriptDataPayload {
  event?: string;
  data?: {
    data?: {
      participant?: { name?: string };
      words?: NormalizerWord[];
    };
  };
}

/**
 * Collapse CR/LF and runs of whitespace to single spaces and trim the edges.
 * Keeps a transcript line on exactly one physical line and free of stray
 * indentation, while preserving all non-whitespace (incl. Unicode) verbatim.
 */
export function sanitizeTranscriptField(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Normalize one Recall `transcript.data` payload to the canonical line, or
 * `null` when the payload is not a `transcript.data` event with words (e.g. a
 * different event, a partial with an empty `words[]`, or malformed input —
 * never throws). The timestamp comes solely from the first word; the speaker
 * defaults to `"?"` when absent/blank.
 */
export function normalizeTranscriptLine(payload: unknown): string | null {
  const p = (payload ?? {}) as TranscriptDataPayload;
  if (p.event !== "transcript.data") {
    return null;
  }
  const inner = p.data?.data ?? {};
  const words = inner.words ?? [];
  if (!words.length) {
    return null;
  }
  const text = sanitizeTranscriptField(words.map((w) => w?.text ?? "").join(" "));
  const speaker = sanitizeTranscriptField(inner.participant?.name ?? "") || "?";
  const absolute = words[0]?.start_timestamp?.absolute ?? "";
  const ts = absolute.slice(0, 19).replace("T", " ");
  return `[${ts}] ${speaker}: ${text}`;
}

/** A stored transcript row rendered back to the canonical CLI line (Story 3). */
export interface RenderableTranscriptLine {
  /** Either the canonical `YYYY-MM-DD HH:MM:SS` or an ISO `…THH:MM:SS.sssZ`. */
  ts: string;
  speaker: string | null;
  text: string;
}

/**
 * Coerce a stored timestamp to the CLI's canonical `YYYY-MM-DD HH:MM:SS`. The
 * ws-hub row mapper emits `new Date(ts).toISOString()` (`…THH:MM:SS.sssZ`); the
 * CLI writes `absolute.slice(0,19).replace("T"," ")` — this collapses both to
 * the same 19-char space form so the download is byte-identical (SPEC §5.4).
 */
function canonicalTs(ts: string): string {
  return ts.slice(0, 19).replace("T", " ");
}

/**
 * Render one stored transcript row to the canonical CLI line
 *     [YYYY-MM-DD HH:MM:SS] Speaker: utterance
 * byte-identical to {@link normalizeTranscriptLine}: the `T`/millis/`Z` are
 * dropped from an ISO `ts`, and a null/blank speaker defaults to `"?"` exactly
 * as the normalizer does. Persisted `speaker`/`text` are already sanitized at
 * ingest, so no re-sanitization is applied (it would be a no-op).
 */
export function renderTranscriptLine(line: RenderableTranscriptLine): string {
  const speaker = (line.speaker ?? "").trim() || "?";
  return `[${canonicalTs(line.ts)}] ${speaker}: ${line.text}`;
}

/**
 * Render a full transcript to plain text — one {@link renderTranscriptLine} per
 * line, each terminated by `"\n"` exactly as the CLI writer does (`line + "\n"`).
 * An empty transcript is the empty string (no stray trailing newline).
 */
export function renderTranscriptText(lines: readonly RenderableTranscriptLine[]): string {
  return lines.map((l) => renderTranscriptLine(l) + "\n").join("");
}
