/**
 * `TranscriptPublisher` PORT — the per-`call_id` pub/sub fan-out seam
 * (SPEC §5.5 "one in-process pub/sub channel per call_id", §5.11).
 *
 * One channel per call. The ingest transcript pipeline (#78) publishes each
 * persisted line; the tunnel watchdog (#81) and call lifecycle (#79) publish
 * control frames (tunnel warnings / status changes) onto the SAME channel; the
 * ws-hub WS upgrade (#83) consumes it and fans frames out to subscribers. This
 * module owns ONLY the port + an in-memory fake (for tests) + a Postgres
 * `LISTEN/NOTIFY`-backed impl; ws-hub backpressure / `?since_seq` replay are the
 * backend track and live in `apps/ws-hub`, not here.
 */
import type { SQL } from "bun";
import type { TranscriptLineKind } from "./index.ts";

/** A persisted transcript line fanned out on a call's channel (§5.4/§5.10 shape). */
export interface TranscriptLineFrame {
  type: "line";
  call_id: string;
  /** Monotonic per-call sequence (PK `(call_id, seq)`). */
  seq: number;
  /** Canonical `YYYY-MM-DD HH:MM:SS` string (byte-identical to the CLI, §5.4). */
  ts: string;
  speaker: string;
  /** The utterance only — `[ts] speaker: text` re-renders the CLI line. */
  text: string;
  /**
   * Line kind (#195): a `chat` frame re-renders as `[ts] speaker (chat): text`.
   * OMITTED for a spoken line (kind='speech') so the wire shape stays byte-
   * identical to pre-#195. The `pg_notify` SIGNAL never carries it — the ws-hub
   * fan-in re-hydrates `kind` from the persisted `transcripts.kind` column.
   */
  kind?: TranscriptLineKind;
}

/**
 * A control/system frame interleaved on the same per-call channel — e.g. the
 * tunnel watchdog's `SAMOGRAPH-WARNING` lines (§4.5) or a status change (§5.2).
 * The discriminant is anything other than `"line"`; extra fields are passed
 * through to the consumer untouched.
 */
export interface TranscriptControlFrame {
  type: "warning" | "status" | "degraded";
  call_id: string;
  [key: string]: unknown;
}

/** Anything publishable on a call's channel. */
export type TranscriptFrame = TranscriptLineFrame | TranscriptControlFrame;

/**
 * The fan-out seam. `exec` lets a caller publish INSIDE an open transaction so
 * the Postgres impl's `NOTIFY` is delivered iff that tx commits (exactly-once
 * on commit; dropped on rollback) — the in-memory fake ignores it.
 */
export interface TranscriptPublisher {
  publish(frame: TranscriptFrame, exec?: SQL): void | Promise<void>;
}

/**
 * The NOTIFY payload (SPEC §5.5, issue #98). The `pg_notify` payload is hard-
 * capped by Postgres at 8000 bytes; a long utterance's full line-frame JSON can
 * exceed that, and the throw would roll back the wrapping dedup transaction
 * (#93) → Recall re-delivers → loop / lost line on the LIVE path (#98). So the
 * NOTIFY carries only a LIGHTWEIGHT SIGNAL, never the full text:
 *
 *   • a line  → `{ k:"line", call_id, seq }` — tiny + constant-size regardless of
 *     utterance length; the ws-hub fan-in fetches the row by `(call_id, seq)`
 *     from `transcripts` (RLS-scoped) to recover the full frame.
 *   • a control frame (tunnel warning / status / degraded, §4.5/§5.2) → carried
 *     inline (`{ k:"ctl", frame }`): these are small + bounded and have no `seq`
 *     to fetch by.
 */
export type TranscriptSignal =
  | { k: "line"; call_id: string; seq: number }
  | { k: "ctl"; frame: TranscriptControlFrame };

/** Reduce a publishable frame to its NOTIFY signal (the #98 8 KB-safe encoding). */
export function encodeSignal(frame: TranscriptFrame): TranscriptSignal {
  return frame.type === "line"
    ? { k: "line", call_id: frame.call_id, seq: frame.seq }
    : { k: "ctl", frame };
}

/** Parse a NOTIFY payload back into a {@link TranscriptSignal}, or `null` if malformed. */
export function parseSignal(payload: string): TranscriptSignal | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.k === "line") {
    if (typeof obj.call_id !== "string" || typeof obj.seq !== "number") return null;
    return { k: "line", call_id: obj.call_id, seq: obj.seq };
  }
  if (obj.k === "ctl") {
    const frame = obj.frame as TranscriptControlFrame | undefined;
    if (!frame || typeof frame.call_id !== "string" || typeof frame.type !== "string") return null;
    return { k: "ctl", frame };
  }
  return null;
}

/** Postgres NAMEDATALEN-1 cap on channel names. */
const MAX_CHANNEL_BYTES = 63;

/**
 * The per-call `LISTEN/NOTIFY` channel name. `transcript:<uuid>` is 47 bytes —
 * comfortably under the 63-byte cap — and distinct per `call_id` (§5.5).
 */
export function transcriptChannel(callId: string): string {
  const channel = `transcript:${callId}`;
  if (channel.length > MAX_CHANNEL_BYTES) {
    throw new Error(`transcript channel exceeds ${MAX_CHANNEL_BYTES} bytes: ${channel}`);
  }
  return channel;
}

/**
 * In-memory {@link TranscriptPublisher} for tests — records every frame in
 * publish order and lets a test inspect one call's channel in isolation.
 */
export class InMemoryTranscriptPublisher implements TranscriptPublisher {
  /** Every frame published, in order, across all channels. */
  readonly published: TranscriptFrame[] = [];

  publish(frame: TranscriptFrame): void {
    this.published.push(frame);
  }

  /** Frames published on one call's channel (proves cross-call isolation). */
  framesFor(callId: string): TranscriptFrame[] {
    return this.published.filter((f) => f.call_id === callId);
  }

  /** Line frames only, on one call's channel. */
  linesFor(callId: string): TranscriptLineFrame[] {
    return this.framesFor(callId).filter(
      (f): f is TranscriptLineFrame => f.type === "line",
    );
  }
}

/** Construct an {@link InMemoryTranscriptPublisher}. */
export function createInMemoryTranscriptPublisher(): InMemoryTranscriptPublisher {
  return new InMemoryTranscriptPublisher();
}

/**
 * Postgres `LISTEN/NOTIFY`-backed {@link TranscriptPublisher}, keyed per
 * `call_id`. Publishes via `pg_notify(channel, json)`; ws-hub `LISTEN`s on the
 * channel per subscribed call.
 *
 * When `exec` (the dispatch tx) is supplied the `NOTIFY` is TRANSACTIONAL —
 * Postgres holds it until COMMIT and discards it on ROLLBACK, so a published
 * line is exactly the set of persisted lines (matches the at-most-once
 * persistence guarantee, §5.5). Without `exec` it fires immediately on the
 * publisher's own connection (used for out-of-band control frames).
 *
 * The payload is a {@link TranscriptSignal} ({@link encodeSignal}), NOT the full
 * frame (#98): a long utterance's line carries only `{ call_id, seq }`, so the
 * 8 KB `pg_notify` cap can never throw inside — and thus never roll back — the
 * dedup tx. The ws-hub fan-in re-hydrates the line by `(call_id, seq)`.
 */
export class PgListenNotifyPublisher implements TranscriptPublisher {
  constructor(private readonly sql: SQL) {}

  async publish(frame: TranscriptFrame, exec?: SQL): Promise<void> {
    const target = exec ?? this.sql;
    const payload = JSON.stringify(encodeSignal(frame));
    await target`SELECT pg_notify(${transcriptChannel(frame.call_id)}, ${payload})`;
  }
}
