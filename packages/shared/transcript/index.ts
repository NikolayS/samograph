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

/**
 * The Recall realtime event carrying an INCOMING meeting-chat message (#188),
 * supported on Google Meet + Zoom. Shape: `data.data.participant.{name,...}`,
 * `data.data.timestamp.{absolute,relative}`, `data.data.data.{text,to}`.
 */
export const CHAT_TRANSCRIPT_EVENT = "participant_events.chat_message";

/**
 * Whether a transcript line is spoken audio (`transcript.data`) or a typed
 * meeting-chat message (`participant_events.chat_message`, #188). The kind is
 * carried in-memory; on disk the transcript is plain text, so a `chat` line is
 * encoded solely by the ` (chat)` marker ({@link CHAT_LINE_MARKER}) placed right
 * after the speaker name. A later download filter (with / without comments) can
 * distinguish the two purely from that marker.
 */
export type TranscriptLineKind = "speech" | "chat";

/** The exact marker inserted after the name to encode a chat line on disk. */
export const CHAT_LINE_MARKER = " (chat)";

/** A normalized transcript line plus its {@link TranscriptLineKind}. */
export interface NormalizedTranscriptLine {
  kind: TranscriptLineKind;
  /**
   * The canonical on-disk / wire line (the caller appends the trailing "\n"):
   *   speech → `[YYYY-MM-DD HH:MM:SS] <name>: <text>`
   *   chat   → `[YYYY-MM-DD HH:MM:SS] <name> (chat): <text>`
   */
  line: string;
}

interface ChatMessagePayload {
  event?: string;
  data?: {
    data?: {
      participant?: { name?: string };
      timestamp?: { absolute?: string };
      data?: { text?: string; to?: string };
    };
  };
}

/**
 * Normalize one Recall `participant_events.chat_message` payload (#188) to the
 * canonical chat line
 *     [YYYY-MM-DD HH:MM:SS] <name> (chat): <text>
 * or `null` when the payload is not a chat message or carries no text (never
 * throws). Timestamp slicing and the `?` speaker default are byte-identical to
 * {@link normalizeTranscriptLine}, so chat and speech share one framing apart
 * from the ` (chat)` marker after the name.
 */
export function normalizeChatMessageLine(payload: unknown): string | null {
  const p = (payload ?? {}) as ChatMessagePayload;
  if (p.event !== CHAT_TRANSCRIPT_EVENT) {
    return null;
  }
  const inner = p.data?.data ?? {};
  const text = sanitizeTranscriptField(inner.data?.text ?? "");
  if (!text) {
    return null;
  }
  const speaker = sanitizeTranscriptField(inner.participant?.name ?? "") || "?";
  const absolute = inner.timestamp?.absolute ?? "";
  const ts = absolute.slice(0, 19).replace("T", " ");
  return `[${ts}] ${speaker}${CHAT_LINE_MARKER}: ${text}`;
}

/**
 * Normalize any transcript-bearing Recall event to a
 * {@link NormalizedTranscriptLine} — a `transcript.data` utterance (kind
 * `speech`) or a `participant_events.chat_message` (kind `chat`, #188) — or
 * `null` for anything else (never throws). This is the CLI/agent entry point
 * that carries `kind` through; {@link normalizeTranscriptLine} deliberately
 * stays speech-only so the hosted ingest path (which reuses it) is unaffected.
 */
export function normalizeTranscriptEvent(
  payload: unknown,
): NormalizedTranscriptLine | null {
  const speech = normalizeTranscriptLine(payload);
  if (speech !== null) {
    return { kind: "speech", line: speech };
  }
  const chat = normalizeChatMessageLine(payload);
  if (chat !== null) {
    return { kind: "chat", line: chat };
  }
  return null;
}

/**
 * The structured columns of ONE normalized transcript-bearing event — the shape
 * the HOSTED ingest path persists (`transcripts.{ts,speaker,text,kind}`) and the
 * wire/download re-render from. Unlike {@link normalizeTranscriptEvent} (which
 * returns a pre-formatted line string), this keeps `speaker` MARKER-FREE and
 * carries the `kind` separately, so the ` (chat)` marker is purely a render
 * concern ({@link formatTranscriptLineWithKind}).
 */
export interface NormalizedTranscriptRow {
  kind: TranscriptLineKind;
  /** `YYYY-MM-DD HH:MM:SS` (may be "" when the source carried no timestamp). */
  ts: string;
  /** Sanitized sender/speaker; `"?"` when absent/blank. NO ` (chat)` marker. */
  speaker: string;
  /** Sanitized utterance / message text (one physical line). */
  text: string;
}

/**
 * Normalize a `transcript.data` (kind=speech) or `participant_events.chat_message`
 * (kind=chat, #188) payload to structured {@link NormalizedTranscriptRow} columns,
 * or `null` for anything else / empty (never throws). Every field is sanitized
 * exactly like {@link normalizeTranscriptLine} / {@link normalizeChatMessageLine}
 * ({@link sanitizeTranscriptField} — CR/LF + whitespace collapse, trim), so
 * untrusted chat text cannot inject a line break or forge a second line; the
 * timestamp slicing and `"?"` speaker default match those two byte-for-byte.
 */
export function normalizeTranscriptEventRow(payload: unknown): NormalizedTranscriptRow | null {
  const p = (payload ?? {}) as { event?: string };
  if (p.event === "transcript.data") {
    const inner = (payload as TranscriptDataPayload).data?.data ?? {};
    const words = inner.words ?? [];
    if (!words.length) return null;
    const text = sanitizeTranscriptField(words.map((w) => w?.text ?? "").join(" "));
    const speaker = sanitizeTranscriptField(inner.participant?.name ?? "") || "?";
    const absolute = words[0]?.start_timestamp?.absolute ?? "";
    return { kind: "speech", ts: absolute.slice(0, 19).replace("T", " "), speaker, text };
  }
  if (p.event === CHAT_TRANSCRIPT_EVENT) {
    const inner = (payload as ChatMessagePayload).data?.data ?? {};
    const text = sanitizeTranscriptField(inner.data?.text ?? "");
    if (!text) return null;
    const speaker = sanitizeTranscriptField(inner.participant?.name ?? "") || "?";
    const absolute = inner.timestamp?.absolute ?? "";
    return { kind: "chat", ts: absolute.slice(0, 19).replace("T", " "), speaker, text };
  }
  return null;
}

/** Structured input to {@link formatTranscriptLineWithKind}. */
export interface KindedLineInput {
  ts: string;
  speaker: string;
  text: string;
  /** `chat` renders the ` (chat)` marker; `speech`/absent render without it. */
  kind?: TranscriptLineKind;
}

/**
 * The ONE shared formatter for a canonical transcript line that carries a kind:
 *
 *   speech (or an absent kind) → `[ts] speaker: text`  (byte-identical to the CLI)
 *   chat                       → `[ts] speaker (chat): text`  (#188/#195)
 *
 * The web live renderer AND the plain-text download reuse it, so `Name (chat):`
 * has a single source of truth. The speaker is emitted verbatim (already
 * sanitized/`?`-defaulted upstream); the caller owns any trailing "\n".
 */
export function formatTranscriptLineWithKind(input: KindedLineInput): string {
  const marker = input.kind === "chat" ? CHAT_LINE_MARKER : "";
  return `[${input.ts}] ${input.speaker}${marker}: ${input.text}`;
}

/** A stored transcript row rendered back to the canonical CLI line (Story 3). */
export interface RenderableTranscriptLine {
  /** Either the canonical `YYYY-MM-DD HH:MM:SS` or an ISO `…THH:MM:SS.sssZ`. */
  ts: string;
  speaker: string | null;
  text: string;
  /** Line kind (#195): a `chat` row renders the ` (chat)` marker after the name. */
  kind?: TranscriptLineKind;
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
 *     [YYYY-MM-DD HH:MM:SS] Speaker: utterance          (kind='speech'/absent)
 *     [YYYY-MM-DD HH:MM:SS] Speaker (chat): utterance    (kind='chat', #195)
 * byte-identical to {@link normalizeTranscriptLine}: the `T`/millis/`Z` are
 * dropped from an ISO `ts`, and a null/blank speaker defaults to `"?"` exactly
 * as the normalizer does. Persisted `speaker`/`text` are already sanitized at
 * ingest, so no re-sanitization is applied (it would be a no-op). Delegates to
 * {@link formatTranscriptLineWithKind} so the ` (chat)` marker has one source of
 * truth shared with the live web renderer.
 */
export function renderTranscriptLine(line: RenderableTranscriptLine): string {
  const speaker = (line.speaker ?? "").trim() || "?";
  return formatTranscriptLineWithKind({
    ts: canonicalTs(line.ts),
    speaker,
    text: line.text,
    kind: line.kind,
  });
}

/**
 * Render a full transcript to plain text — one {@link renderTranscriptLine} per
 * line, each terminated by `"\n"` exactly as the CLI writer does (`line + "\n"`).
 * An empty transcript is the empty string (no stray trailing newline).
 */
export function renderTranscriptText(lines: readonly RenderableTranscriptLine[]): string {
  return lines.map((l) => renderTranscriptLine(l) + "\n").join("");
}
