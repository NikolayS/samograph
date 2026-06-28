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
 */

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

export interface RecallFakeOptions {
  seed: string;
}

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

  constructor(options: RecallFakeOptions) {
    this.seed = options.seed;
    this.botId = `bot_${fnv1a32(options.seed)}`;
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
}

export function createRecallFake(options: RecallFakeOptions): RecallFake {
  return new RecallFake(options);
}
