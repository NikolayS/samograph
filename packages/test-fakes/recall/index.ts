/**
 * Deterministic, seedable, network-free in-repo Recall fake.
 *
 * This is the PR-gate Recall per SPEC §6.1: every PR exercises this fake; a
 * separate nightly job runs the same scenarios against the real Recall sandbox.
 *
 * Everything is a pure function of the seed (plus explicit arguments) — no
 * `Date.now()`, no randomness, no I/O — so events are BYTE-STABLE across runs
 * and machines, which is what the §6.2 #8 acceptance test pins exactly.
 *
 * Payload shapes intentionally match what `src/transcript.ts` consumes
 * (`transcript.data` → `data.data.{participant,words}`) and the bot-lifecycle
 * status-change shape ingest will drive call-status transitions from.
 *
 * The signed webhook envelope (`webhook(...)`) lets every downstream ingest
 * issue drive `POST /webhook?bot=&t=` with no real Recall and no tokens (§6.1):
 * it signs with the SAME pinned scheme the ingest verifier imports, so the two
 * sides can never drift (§5.3, §6.2 #7).
 */
import {
  RECALL_SIGNATURE_HEADER,
  recallSignature,
  verifyRecallSignature,
} from "../../shared/recall/signature.ts";

// Re-exported so tests import the signing primitives straight from the fake.
export { RECALL_SIGNATURE_HEADER, recallSignature, verifyRecallSignature };

/** Bot lifecycle status codes the fake can synthesize (SPEC §6.2 #8). */
export type LifecycleCode =
  | "in_call_recording"
  | "in_call_not_recording"
  | "call_ended"
  | "bot_removed"
  | "fatal";

export interface BotStatus {
  code: LifecycleCode;
  /** Recall reason string (e.g. `meeting_not_found`); only set for `fatal`. */
  sub_code: string | null;
  message: string | null;
  created_at: string;
}

export interface BotStatusChangeEvent {
  event: "bot.status_change";
  data: {
    bot_id: string;
    status: BotStatus;
  };
}

export interface TranscriptWord {
  text: string;
  start_timestamp: { absolute: string };
}

export interface TranscriptDataEvent {
  event: "transcript.data";
  data: {
    data: {
      participant: { name: string };
      words: TranscriptWord[];
    };
  };
}

/** Any event the fake can wrap in a signed webhook envelope. */
export type RecallEvent = BotStatusChangeEvent | TranscriptDataEvent;

export interface RecallFakeOptions {
  seed: string;
}

export interface WebhookOptions {
  /** Plaintext IngestSecret placed in `?t=` (drives §5.3 step-3 match/mismatch). */
  ingestSecret?: string;
  /** `?bot=` override; defaults to the fake's seed-derived bot id. */
  bot?: string;
  /** Public base for the built URL; defaults to a deterministic local host. */
  baseUrl?: string;
  /** Distinguishes otherwise-identical events of the same kind/seed (default 0). */
  offset?: number;
}

/** A signed webhook delivery: everything needed to build a `POST /webhook`. */
export interface WebhookEnvelope {
  /** `<base>/webhook?bot=<id>&t=<ingest_secret>`. */
  url: string;
  /** Request headers, including the pinned Recall signature header. */
  headers: Record<string, string>;
  /** The EXACT bytes that were signed (and must be POSTed verbatim). */
  rawBody: string;
  /** The deterministic idempotency key carried in the body (§6.2 #7). */
  recallEventId: string;
}

const DEFAULT_WEBHOOK_BASE = "https://ingest.local";

export interface LifecycleOptions {
  /** Override the Recall reason string surfaced on `fatal` (SPEC §6.2 #8). */
  reason?: string;
}

export interface TranscriptDataOptions {
  words: string[];
  speaker?: string;
  /** ISO-8601 absolute timestamp for the words; deterministic default. */
  at?: string;
}

/** FNV-1a (32-bit) — a tiny, dependency-free, fully deterministic string hash. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Fixed synthetic epoch so timestamps never depend on the wall clock. */
const BASE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00.000Z

/** Each lifecycle code maps to a fixed offset → a stable, distinct created_at. */
const CODE_OFFSET_SECONDS: Record<LifecycleCode, number> = {
  fatal: 0,
  in_call_recording: 1,
  in_call_not_recording: 2,
  call_ended: 3,
  bot_removed: 4,
};

const DEFAULT_FATAL_REASON = "meeting_not_found";
const DEFAULT_SPEAKER = "Speaker";

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString();
}

export class RecallFake {
  readonly seed: string;
  /** Stable bot id derived purely from the seed. */
  readonly botId: string;

  /** Per-fake (stands in for the per-region) webhook secret — pure of the seed. */
  readonly webhookSecret: string;
  /** Per-call plaintext IngestSecret (`?t=`) — pure of the seed (§4.2). */
  readonly ingestSecret: string;

  constructor(options: RecallFakeOptions) {
    this.seed = options.seed;
    this.botId = `bot_${fnv1a32(options.seed)}`;
    this.webhookSecret = `whsec_${fnv1a32(`recall-webhook-secret|${options.seed}`)}`;
    this.ingestSecret = `ingsec_${fnv1a32(`ingest-secret|${options.seed}`)}`;
  }

  /** Recall `POST /bot/` response shape (`{ id }`), as `src/recall.ts` uses. */
  createBot(): { id: string } {
    return { id: this.botId };
  }

  /** Synthesize a byte-stable bot-lifecycle status-change event. */
  lifecycle(code: LifecycleCode, options: LifecycleOptions = {}): BotStatusChangeEvent {
    const sub_code =
      code === "fatal" ? options.reason ?? DEFAULT_FATAL_REASON : null;
    return {
      event: "bot.status_change",
      data: {
        bot_id: this.botId,
        status: {
          code,
          sub_code,
          message: null,
          created_at: isoAt(CODE_OFFSET_SECONDS[code]),
        },
      },
    };
  }

  /** Synthesize a `transcript.data` payload matching the CLI's consumed shape. */
  transcriptData(options: TranscriptDataOptions): TranscriptDataEvent {
    const absolute = options.at ?? isoAt(90);
    const speaker = options.speaker ?? DEFAULT_SPEAKER;
    return {
      event: "transcript.data",
      data: {
        data: {
          participant: { name: speaker },
          words: options.words.map((text) => ({
            text,
            start_timestamp: { absolute },
          })),
        },
      },
    };
  }

  /**
   * Wrap any `lifecycle(...)` / `transcriptData(...)` event in a signed webhook
   * envelope: a top-level deterministic `recall_event_id`, the pinned Recall
   * signature header over the EXACT raw body, and `?bot=&t=` query params. Pure
   * of `(seed, event, options)` — byte-stable across runs and machines (§6.1).
   */
  webhook(event: RecallEvent, options: WebhookOptions = {}): WebhookEnvelope {
    const offset = options.offset ?? 0;
    const recallEventId = `evt_${fnv1a32(`${this.seed}|${eventKind(event)}|${offset}`)}`;
    // recall_event_id first so the (idempotency) key leads the byte-stable body.
    const rawBody = JSON.stringify({ recall_event_id: recallEventId, ...event });

    const bot = options.bot ?? this.botId;
    const ingestSecret = options.ingestSecret ?? this.ingestSecret;
    const base = options.baseUrl ?? DEFAULT_WEBHOOK_BASE;
    const query = new URLSearchParams({ bot, t: ingestSecret });

    return {
      url: `${base}/webhook?${query.toString()}`,
      headers: {
        [RECALL_SIGNATURE_HEADER]: recallSignature(rawBody, this.webhookSecret),
        "content-type": "application/json",
      },
      rawBody,
      recallEventId,
    };
  }

  /** True iff the envelope's signature header is valid for this fake's secret. */
  verify(envelope: WebhookEnvelope): boolean {
    return verifyRecallSignature(
      envelope.rawBody,
      envelope.headers[RECALL_SIGNATURE_HEADER],
      this.webhookSecret,
    );
  }

  /** A copy of the envelope with a tampered signature (body left intact). */
  badSignature(envelope: WebhookEnvelope): WebhookEnvelope {
    const sig = envelope.headers[RECALL_SIGNATURE_HEADER] ?? "";
    const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    return { ...envelope, headers: { ...envelope.headers, [RECALL_SIGNATURE_HEADER]: flipped } };
  }

  /** A re-delivery of the SAME event bytes (Recall is at-least-once, §6.2 #7). */
  replay(envelope: WebhookEnvelope): WebhookEnvelope {
    return {
      url: envelope.url,
      headers: { ...envelope.headers },
      rawBody: envelope.rawBody,
      recallEventId: envelope.recallEventId,
    };
  }
}

/**
 * The discriminator folded into `recall_event_id` so distinct events get
 * distinct ids: the event kind, plus the lifecycle code for status changes
 * (otherwise two same-seed lifecycle events at offset 0 would collide).
 */
function eventKind(event: RecallEvent): string {
  return event.event === "bot.status_change"
    ? `bot.status_change:${event.data.status.code}`
    : event.event;
}

export function createRecallFake(options: RecallFakeOptions): RecallFake {
  return new RecallFake(options);
}
