import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";
import { localTranscriptLines } from "../transcript.ts";
import { DEFAULT_INTRO_TEXT } from "../introText.ts";
import { cmdChat } from "./chat.ts";

export interface IntroDeps {
  recall?: RecallClient;
  fetchFn?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Override the transcript file scanned for --context (tests). */
  transcriptPath?: string;
}

// A transcript utterance looks like "[timestamp] Speaker: text". Warning lines
// ("[ts] SAMOGRAPH-WARNING: ...") match the same shape, so they're skipped.
const UTTERANCE_RE = /^\[[^\]]+\]\s+([^:]+):\s*(.*)$/;

/** First real spoken line in the transcript, or null if none yet. */
export function firstHeardLine(
  path?: string,
): { speaker: string; text: string } | null {
  for (const line of localTranscriptLines(path)) {
    const m = line.match(UTTERANCE_RE);
    if (!m) continue;
    const speaker = m[1]!.trim();
    const text = m[2]!.trim();
    if (!text || speaker.startsWith("SAMOGRAPH-WARNING")) continue;
    return { speaker, text };
  }
  return null;
}

/**
 * Build the introduction message: a custom `--intro-text` or the default, with
 * an optional first-heard-line "context" tail appended when `--context` is set
 * and the transcript already has a spoken line.
 */
export function buildIntroMessage(
  args: ParsedArgs,
  transcriptPath?: string,
): string {
  const custom = args.intro_text?.trim();
  let message = custom && custom.length ? custom : DEFAULT_INTRO_TEXT;
  if (args.context) {
    const first = firstHeardLine(transcriptPath);
    if (first) {
      message += `\n\nThe first thing I heard was — ${first.speaker}: "${first.text}"`;
    }
  }
  return message;
}

// `intro` posts a short self-introduction into the meeting chat on demand. It
// reuses `chat` for the actual send (so the same bot-id resolution, error
// handling, and camera chime apply); this command just composes the text.
export async function cmdIntro(
  args: ParsedArgs,
  deps: IntroDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const message = buildIntroMessage(args, deps.transcriptPath);
  await cmdChat(
    { command: "chat", message, bot_id: args.bot_id ?? null },
    { recall, fetchFn: deps.fetchFn },
  );
}

const IN_CALL_STATUSES = new Set([
  "in_call_recording",
  "in_call_not_recording",
]);

/** Latest Recall bot status code from a getBot response. */
function latestStatusCode(bot: unknown): string {
  const changes = (bot as { status_changes?: Array<{ code?: unknown }> })
    ?.status_changes;
  if (Array.isArray(changes) && changes.length) {
    return String(changes[changes.length - 1]?.code ?? "");
  }
  return "";
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PostIntroOnJoinOpts {
  tries?: number;
  delayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Best-effort: post the intro right after join, once the bot is actually in the
 * call. A freshly created bot may still be joining or in a waiting room, when
 * send_chat_message would fail — so poll the bot status briefly first. Never
 * throws; on timeout it prints a hint to run `samograph intro` manually.
 */
export async function postIntroOnJoin(
  recall: RecallClient,
  botId: string,
  text: string,
  opts: PostIntroOnJoinOpts = {},
): Promise<boolean> {
  const tries = opts.tries ?? 12;
  const delayMs = opts.delayMs ?? 2500;
  const sleepFn = opts.sleepFn ?? realSleep;
  for (let i = 0; i < tries; i++) {
    try {
      const bot = await recall.getBot(botId);
      if (IN_CALL_STATUSES.has(latestStatusCode(bot))) {
        // The bot is in the call: send exactly once. Whatever the response,
        // do not retry — a second send_chat_message would double-post the
        // intro. A non-ok response is reported but treated as terminal.
        const resp = await recall.sendChat(botId, text);
        if (resp.ok) {
          process.stdout.write("Posted intro to meeting chat.\n");
          return true;
        }
        process.stderr.write(
          `Note: posting the intro returned HTTP ${resp.status}. ` +
            "Run 'samograph intro' to retry if it did not appear.\n",
        );
        return false;
      }
    } catch {
      // transient (e.g. getBot failed) — retry until tries run out
    }
    if (i < tries - 1) await sleepFn(delayMs);
  }
  process.stderr.write(
    "Note: could not post the intro yet (bot not in the call). " +
      "Run 'samograph intro' once it has joined.\n",
  );
  return false;
}
