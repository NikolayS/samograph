import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { samographDir } from "../config.ts";
import { botIdFromArgsOrState, loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";
import { mp3DurationSeconds } from "../mp3.ts";
import { TranscriptTail } from "../transcriptTail.ts";
import {
  chunkText,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_MAX_WORDS,
  detectLang,
  planSpeech,
  type SpeechPlan,
} from "../speech.ts";
import {
  defaultTtsDeps,
  redactSecrets,
  resolveProvider,
  synthesize,
  TTS_PROVIDERS,
  type TtsConfig,
  type TtsDeps,
  type TtsProviderName,
} from "../tts.ts";

// Recall's output_audio `b64_data` field accepts at most 1,835,008 characters
// (~1.4 MB of MP3), per the Recall API reference for Output Audio. Sentence
// chunks are far below this; the check guards against a pathological chunk.
export const RECALL_OUTPUT_AUDIO_MAX_B64 = 1_835_008;
const POLL_MS = 200;
const GAP_MS = 150; // small pause between sentences

export interface SayDeps {
  recall?: RecallClient;
  tts?: TtsDeps;
  /** Used for the local presence server (best-effort). */
  fetchFn?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Playback duration of an MP3 chunk, in seconds. */
  durationOf?: (mp3: Uint8Array) => number;
  pidAlive?: (pid: number) => boolean;
}

function lockFile(): string {
  return join(samographDir(), "say.lock.json");
}
function stopFile(): string {
  return join(samographDir(), "say.stop");
}
function historyFile(): string {
  return join(samographDir(), "say.json");
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writePrivate(path: string, content: string): void {
  mkdirSync(samographDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function numberSetting(
  flag: number | null | undefined,
  envName: string,
  fallback: number,
  env: Record<string, string | undefined>,
): number {
  if (flag !== null && flag !== undefined) return flag;
  const raw = env[envName];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${envName} must be a non-negative number, got '${raw}'`);
  }
  return n;
}

/** Provider/voice/model/speed: flag, else SAMOGRAPH_TTS_* env, else default. */
export function resolveTtsConfig(args: ParsedArgs, env: Record<string, string | undefined>): TtsConfig {
  const provider = (args.tts_provider ?? env.SAMOGRAPH_TTS_PROVIDER ?? "auto").trim().toLowerCase();
  if (provider !== "auto" && !(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `unknown TTS provider '${provider}' (choose from auto, ${TTS_PROVIDERS.join(", ")})`,
    );
  }
  const speed = numberSetting(args.tts_speed, "SAMOGRAPH_TTS_SPEED", 1, env);
  if (speed <= 0) throw new Error("speed must be greater than 0");
  return {
    provider: provider as TtsProviderName | "auto",
    voice: args.voice || env.SAMOGRAPH_TTS_VOICE || null,
    model: args.tts_model || env.SAMOGRAPH_TTS_MODEL || null,
    speed,
  };
}

// Best-effort presence toggle (bare state, so no Comments-lane entry).
async function setPresence(
  fetchFn: NonNullable<SayDeps["fetchFn"]>,
  state: "speaking" | "listening",
): Promise<void> {
  try {
    const s = loadState();
    const url = s.local_presence_update_url;
    const token = s.presence_write_token;
    if (typeof url !== "string" || !url || typeof token !== "string" || !token) return;
    await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Samograph-Presence-Token": token },
      body: JSON.stringify({ state }),
    });
  } catch {
    // ignore — presence is a nicety
  }
}

async function stopRecallAudio(recall: RecallClient, botId: string): Promise<string> {
  if (!recall.stopOutputAudio) return "not supported by client";
  try {
    const r = await recall.stopOutputAudio(botId);
    if (r.ok) return "ok";
    await r.text().catch(() => "");
    return `HTTP ${r.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Watches the live transcript file for a human speaking after `startMs`.
 * Ignores chat lines, samograph warnings/sentinels, the bot's own name, and
 * utterances that started before playback (late transcript delivery).
 */
export class BargeInWatcher {
  private tail: TranscriptTail;
  constructor(
    path: string,
    private startMs: number,
    private botName: string | null,
  ) {
    this.tail = new TranscriptTail(path);
  }

  /** Returns the interrupting speaker's name, or null. */
  poll(): string | null {
    const startSec = Math.floor(this.startMs / 1000) * 1000;
    for (const e of this.tail.readEntries()) {
      if (e.source === "chat" || e.system) continue;
      if (this.botName && e.speaker === this.botName) continue;
      if (Number.isFinite(e.ts) && e.ts < startSec) continue;
      return e.speaker;
    }
    return null;
  }
}

/** `samograph say --stop`: stop the running `say` and any audio Recall is playing. */
async function cmdSayStop(args: ParsedArgs, deps: SayDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  writePrivate(stopFile(), String(now()));
  const lock = readJson(lockFile());
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const running = typeof lock?.pid === "number" && pidAlive(lock.pid);
  let recallResult = "skipped (no active bot)";
  const state = loadState();
  const bid = args.bot_id || (typeof state.bot_id === "string" ? state.bot_id : null);
  if (bid) {
    const recall = deps.recall ?? makeRecallClient();
    recallResult = await stopRecallAudio(recall, bid);
  }
  if (!running) rmSync(stopFile(), { force: true });
  process.stdout.write(
    `Stop: ${running ? `signalled say (pid ${lock!.pid})` : "no say in progress"}; ` +
      `Recall stop output audio: ${recallResult}\n`,
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export async function cmdSay(args: ParsedArgs, deps: SayDeps = {}): Promise<void> {
  if (args.say_stop) return cmdSayStop(args, deps);

  const ttsDeps = deps.tts ?? defaultTtsDeps();
  const env = ttsDeps.env;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const durationOf = deps.durationOf ?? mp3DurationSeconds;
  const presenceFetch = deps.fetchFn ?? fetch;

  const text = (args.message ?? "").trim();
  if (!text) throw new Error("nothing to say: text is empty");

  const cfg = resolveTtsConfig(args, env);
  const lang = detectLang(text, args.lang ?? env.SAMOGRAPH_SAY_LANG ?? "auto");
  const maxWords = numberSetting(args.max_words, "SAMOGRAPH_SAY_MAX_WORDS", DEFAULT_MAX_WORDS, env);
  const cooldownSec = numberSetting(args.cooldown, "SAMOGRAPH_SAY_COOLDOWN", DEFAULT_COOLDOWN_SECONDS, env);
  const plan: SpeechPlan = planSpeech(text, {
    maxWords,
    longMode: args.long_mode === "truncate" ? "truncate" : "ask",
    alsoChat: args.also_chat === true,
    lang,
    topic: args.topic,
    askText: args.ask_text,
  });
  const chunks = chunkText(plan.spoken);
  const provider = resolveProvider(cfg.provider, ttsDeps);

  if (plan.policy !== "full") {
    process.stderr.write(
      `samograph: note: text is ${plan.words} words (limit ${maxWords}); ` +
        (plan.policy === "ask"
          ? "speaking a short ask and posting the full text to chat"
          : "speaking the first sentence(s) and posting the full text to chat") +
        ". Raise the limit with --max-words N (0 = no limit).\n",
    );
  }

  // --out: synthesize only (no call, no chat). Useful to audition a voice.
  if (args.out) {
    const parts: Uint8Array[] = [];
    try {
      for (const c of chunks) parts.push(await synthesize(provider, c, cfg, lang, ttsDeps));
    } catch (e) {
      throw new Error(redactSecrets(e instanceof Error ? e.message : String(e), env));
    }
    const mp3 = concat(parts);
    writeFileSync(args.out, mp3);
    process.stdout.write(
      `Wrote ${args.out} (${mp3.length} bytes, ~${durationOf(mp3).toFixed(1)}s, provider ${provider})\n`,
    );
    return;
  }

  const recall = deps.recall ?? makeRecallClient();
  const bid = botIdFromArgsOrState(args.bot_id);
  const pidAlive = deps.pidAlive ?? defaultPidAlive;

  const lock = readJson(lockFile());
  if (typeof lock?.pid === "number" && lock.pid !== process.pid && pidAlive(lock.pid)) {
    throw new Error(
      `already speaking (pid ${lock.pid}); run 'samograph say --stop' first, or use 'samograph chat'`,
    );
  }
  const priority = args.priority === "high" ? "high" : "normal";
  const lastEnd = readJson(historyFile())?.last_end_ms;
  if (priority === "normal" && typeof lastEnd === "number" && cooldownSec > 0) {
    const elapsed = (now() - lastEnd) / 1000;
    if (elapsed < cooldownSec) {
      throw new Error(
        `cooldown: the bot spoke ${elapsed.toFixed(0)}s ago (cooldown ${cooldownSec}s). ` +
          "Use 'samograph chat' instead, wait, or pass --priority high for something important",
      );
    }
  }

  // Post to chat first, so a spoken "I posted it in the chat" is true.
  if (plan.chat !== null) {
    const resp = await recall.sendChat(bid, plan.chat);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`send_chat_message failed: ${resp.status} ${body}`);
    }
  }

  const startMs = now();
  writePrivate(lockFile(), JSON.stringify({ pid: process.pid, started_at: startMs }));
  rmSync(stopFile(), { force: true });

  const state = loadState();
  const transcriptPath = typeof state.transcript_file === "string" ? state.transcript_file : null;
  const botName = typeof state.bot_name === "string" ? state.bot_name : null;
  const watcher =
    args.no_barge_in || !transcriptPath ? null : new BargeInWatcher(transcriptPath, startMs, botName);

  let signalled = false;
  const onSignal = () => {
    signalled = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const interruption = (): string | null => {
    if (signalled) return "signal";
    const stopTs = Number(existsSync(stopFile()) ? readFileSync(stopFile(), "utf-8") : NaN);
    if (Number.isFinite(stopTs) && stopTs >= startMs) return "say --stop";
    const who = watcher?.poll();
    return who ? `barge-in by ${who}` : null;
  };

  let played = 0;
  let interrupted: string | null = null;
  await setPresence(presenceFetch, "speaking");
  try {
    let next: Promise<Uint8Array> | null = synthesize(provider, chunks[0]!, cfg, lang, ttsDeps);
    for (let i = 0; i < chunks.length; i++) {
      const mp3 = await next!;
      // Prefetch the next sentence while this one plays.
      next = i + 1 < chunks.length ? synthesize(provider, chunks[i + 1]!, cfg, lang, ttsDeps) : null;
      next?.catch(() => {}); // surfaced when awaited
      interrupted = interruption();
      if (interrupted) break;
      const b64 = Buffer.from(mp3).toString("base64");
      if (b64.length > RECALL_OUTPUT_AUDIO_MAX_B64) {
        throw new Error(
          `audio chunk too large for Recall output_audio (${b64.length} > ${RECALL_OUTPUT_AUDIO_MAX_B64} base64 chars)`,
        );
      }
      const resp = await recall.outputAudio(bid, b64);
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `output_audio failed: ${resp.status} ${body}` +
            (resp.status === 400
              ? " (Recall requires automatic_audio_output at bot creation; rejoin with 'samograph join --enable-voice')"
              : ""),
        );
      }
      played += 1;
      const until = now() + durationOf(mp3) * 1000 + GAP_MS;
      while (now() < until) {
        interrupted = interruption();
        if (interrupted) break;
        await sleep(Math.min(POLL_MS, Math.max(0, until - now())));
      }
      if (interrupted) {
        await stopRecallAudio(recall, bid);
        break;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(redactSecrets(msg, env));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    rmSync(lockFile(), { force: true });
    rmSync(stopFile(), { force: true });
    if (played > 0) writePrivate(historyFile(), JSON.stringify({ last_end_ms: now() }));
    await setPresence(presenceFetch, "listening");
  }

  const summary = `${played}/${chunks.length} chunk(s), provider ${provider}, policy ${plan.policy}`;
  if (interrupted) {
    process.stdout.write(`Interrupted (${interrupted}) after ${summary}\n`);
  } else {
    process.stdout.write(`Said (${summary}): ${plan.spoken}\n`);
  }
  if (plan.chat !== null) process.stdout.write(`Posted to chat: ${plan.chat}\n`);
}
