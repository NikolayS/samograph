import { botIdFromArgsOrState, loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";
import { detectLang, type SpeechLang } from "../speech.ts";
import { matchOption, resolveDefault } from "../answer.ts";
import { TranscriptTail, type TranscriptEntry } from "../transcriptTail.ts";
import { cmdSay } from "./say.ts";

export const DEFAULT_ASK_TIMEOUT_SECONDS = 60;
/** Upper bound for --timeout: `ask` must never hold an agent for long. */
export const MAX_ASK_TIMEOUT_SECONDS = 600;
const POLL_MS = 500;
const MAX_HEARD = 10;

export interface AskResult {
  question: string;
  options: string[];
  /** The chosen option, the free-form reply, the default on timeout, or null. */
  answer: string | null;
  /** Who answered (null on timeout). */
  by: string | null;
  source: "voice" | "chat" | null;
  timed_out: boolean;
  /** The raw reply line text (null on timeout). */
  text: string | null;
  /** Human lines heard during the wait that did not match an option. */
  heard: { by: string; source: "voice" | "chat"; text: string }[];
}

export interface AskDeps {
  recall?: RecallClient;
  /** Speak text into the call (default: `samograph say`, priority high). */
  speak?: (text: string, lang: SpeechLang) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Where the JSON result goes (default: stdout). */
  write?: (s: string) => void;
}

function optionsLine(options: string[]): string {
  return options.map((o, i) => `${i + 1}) ${o}`).join("  ");
}

/** Chat text of the question. */
export function chatQuestion(
  question: string,
  options: string[],
  def: string | null,
  timeoutSec: number,
  lang: SpeechLang,
): string {
  const parts = [question.trim()];
  if (options.length) {
    parts.push(`${lang === "ru" ? "Варианты" : "Options"}: ${optionsLine(options)}`);
  }
  const how =
    lang === "ru"
      ? "Ответьте голосом или в чате"
      : "Answer by voice or in chat";
  const fallback =
    def === null
      ? ""
      : lang === "ru"
        ? ` (через ${timeoutSec} с без ответа: ${def})`
        : ` (no answer in ${timeoutSec}s: ${def})`;
  parts.push(`${how}${fallback}.`);
  return parts.join("\n");
}

/** Spoken text of the question (options as a short list, no numbering noise). */
export function spokenQuestion(question: string, options: string[], lang: SpeechLang): string {
  const q = question.trim();
  if (!options.length) return q;
  const or = lang === "ru" ? "или" : "or";
  const list =
    options.length === 1
      ? options[0]!
      : `${options.slice(0, -1).join(", ")} ${or} ${options[options.length - 1]}`;
  return `${q} ${lang === "ru" ? "Варианты" : "Options"}: ${list}.`;
}

export function timeoutAnnouncement(def: string | null, timeoutSec: number, lang: SpeechLang): string {
  if (lang === "ru") {
    return def === null
      ? `Ответа нет за ${timeoutSec} с. Решу сам и напишу в чат.`
      : `Ответа нет за ${timeoutSec} с. Выбираю: ${def}.`;
  }
  return def === null
    ? `No answer in ${timeoutSec}s. I'll decide myself and post it in the chat.`
    : `No answer in ${timeoutSec}s. Going with: ${def}.`;
}

export function ackLine(answer: string, by: string, lang: SpeechLang): string {
  return lang === "ru" ? `Принято: ${answer} (${by}).` : `Got it: ${answer} (${by}).`;
}

/**
 * Default `speak`: run `samograph say` with priority high (a question must not
 * be blocked by the cooldown) and no word limit (the full text is already in
 * chat). `say` prints a status line to stdout; it is sent to stderr so stdout
 * holds only the JSON result.
 */
async function defaultSpeak(text: string, lang: SpeechLang, botId: string): Promise<void> {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) =>
    process.stderr.write(chunk)) as typeof process.stdout.write;
  try {
    await cmdSay({
      command: "say",
      message: text,
      bot_id: botId,
      lang,
      priority: "high",
      max_words: 0,
    });
  } finally {
    process.stdout.write = origWrite;
  }
}

/**
 * `samograph ask`: put a question to the call (chat, plus voice with --voice),
 * then wait a bounded time for an answer in the live transcript, which carries
 * both speech and incoming meeting chat (` (chat)` lines). Prints one JSON
 * object. On timeout, returns --default and announces it in the call.
 *
 * Use this instead of any blocking terminal prompt while in a call: the agent
 * can run it in the background and keep reading the transcript.
 */
export async function cmdAsk(args: ParsedArgs, deps: AskDeps = {}): Promise<AskResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const write = deps.write ?? ((s: string) => void process.stdout.write(s));

  const question = (args.message ?? "").trim();
  if (!question) throw new Error("nothing to ask: question is empty");
  const options = args.ask_options ?? [];
  const timeoutSec = args.ask_timeout ?? DEFAULT_ASK_TIMEOUT_SECONDS;
  const def = resolveDefault(args.ask_default, options);
  if (args.ask_default && def === null) {
    throw new Error(
      `--default '${args.ask_default}' is not one of the options (${options.join(", ")}); ` +
        "use an option name or its number",
    );
  }
  const lang = detectLang(question, args.lang ?? "auto");

  const state = loadState();
  const transcriptPath = typeof state.transcript_file === "string" ? state.transcript_file : null;
  if (!transcriptPath) {
    throw new Error("no live transcript in state; run 'samograph join' first");
  }
  const ownNames = new Set(
    [state.bot_name, state.agent_name].filter((n): n is string => typeof n === "string" && !!n),
  );
  const recall = deps.recall ?? makeRecallClient();
  const bid = botIdFromArgsOrState(args.bot_id);

  // Start reading BEFORE posting, so an instant answer is not missed.
  const tail = new TranscriptTail(transcriptPath);
  const startMs = now();
  const startSec = Math.floor(startMs / 1000) * 1000;

  const posted = chatQuestion(question, options, def, timeoutSec, lang);
  const ownTexts = new Set([posted.trim(), question]);
  const resp = await recall.sendChat(bid, posted);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`send_chat_message failed: ${resp.status} ${body}`);
  }

  const voiceOn = args.ask_voice === true && state.voice_enabled === true;
  if (args.ask_voice && !voiceOn) {
    process.stderr.write(
      "samograph: note: --voice ignored: the bot was not joined with --enable-voice (question posted to chat only)\n",
    );
  }
  const speak = deps.speak ?? ((t: string, l: SpeechLang) => defaultSpeak(t, l, bid));
  const speakSafe = (t: string) =>
    speak(t, lang).catch((e: unknown) => {
      process.stderr.write(
        `samograph: warning: could not speak (${e instanceof Error ? e.message : String(e)}); chat only\n`,
      );
    });
  // Speak in parallel with listening: an answer given while the bot is still
  // talking counts (and barge-in stops the speech).
  const speaking = voiceOn ? speakSafe(spokenQuestion(question, options, lang)) : Promise.resolve();

  process.stderr.write(`samograph: asked; waiting up to ${timeoutSec}s for an answer\n`);

  const heard: AskResult["heard"] = [];
  const isOwn = (e: TranscriptEntry) =>
    e.system ||
    ownNames.has(e.speaker) ||
    ownTexts.has(e.text.trim());

  let found: { answer: string; entry: TranscriptEntry } | null = null;
  const deadline = startMs + timeoutSec * 1000;
  while (!found) {
    for (const e of tail.readEntries()) {
      if (isOwn(e)) continue;
      // A line that started before the question is not an answer to it.
      if (Number.isFinite(e.ts) && e.ts < startSec) continue;
      if (!e.text.trim()) continue;
      if (!options.length) {
        found = { answer: e.text.trim(), entry: e };
        break;
      }
      const m = matchOption(e.text, options);
      if (m.kind === "match") {
        found = { answer: options[m.index]!, entry: e };
        break;
      }
      if (heard.length < MAX_HEARD) heard.push({ by: e.speaker, source: e.source, text: e.text });
    }
    if (found || now() >= deadline) break;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }

  await speaking;

  let result: AskResult;
  if (found) {
    result = {
      question,
      options,
      answer: found.answer,
      by: found.entry.speaker,
      source: found.entry.source,
      timed_out: false,
      text: found.entry.text,
      heard,
    };
    // Tell the call it was heard (chat only: short, no chime, no talking over).
    await recall
      .sendChat(bid, ackLine(found.answer, found.entry.speaker, lang))
      .then((r) => (r.ok ? undefined : r.text()))
      .catch(() => undefined);
  } else {
    result = {
      question,
      options,
      answer: def,
      by: null,
      source: null,
      timed_out: true,
      text: null,
      heard,
    };
    const note = timeoutAnnouncement(def, timeoutSec, lang);
    await recall
      .sendChat(bid, note)
      .then((r) => (r.ok ? undefined : r.text()))
      .catch(() => undefined);
    if (voiceOn) await speakSafe(note);
  }

  write(JSON.stringify(result) + "\n");
  return result;
}
