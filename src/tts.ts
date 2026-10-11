// Pluggable text-to-speech for `samograph say`. Every provider returns MP3
// bytes, because Recall's output_audio endpoint only accepts `kind: "mp3"`.
//
// Providers (auto order): elevenlabs (ELEVENLABS_API_KEY) -> openai
// (OPENAI_API_KEY) -> macos (`say` + ffmpeg/lame) -> espeak (espeak-ng +
// ffmpeg/lame). API keys are read from the environment only and are never
// printed: every error message passes through redactSecrets().

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechLang } from "./speech.ts";

export const TTS_PROVIDERS = ["elevenlabs", "openai", "macos", "espeak"] as const;
export type TtsProviderName = (typeof TTS_PROVIDERS)[number];

export const OPENAI_DEFAULT_MODEL = "gpt-4o-mini-tts";
export const OPENAI_DEFAULT_VOICE = "alloy";
export const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";
// ElevenLabs premade voice "George" (multilingual). Override with --voice.
export const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const MACOS_DEFAULT_VOICE: Record<SpeechLang, string> = { en: "Samantha", ru: "Milena" };
const ESPEAK_DEFAULT_VOICE: Record<SpeechLang, string> = { en: "en-us", ru: "ru" };
const BASE_WPM = 175; // default rate for `say` and espeak-ng

export type Env = Record<string, string | undefined>;

export interface RunResult {
  code: number;
  stderr: string;
}

export interface TtsDeps {
  env: Env;
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  /** Resolve a binary on PATH; null when missing. */
  which: (bin: string) => string | null;
  /** Run a command (argv, no shell). */
  run: (argv: string[]) => Promise<RunResult>;
  platform: string;
}

export interface TtsConfig {
  provider: TtsProviderName | "auto";
  voice: string | null;
  model: string | null;
  speed: number;
}

export class TtsError extends Error {}

export function defaultTtsDeps(): TtsDeps {
  return {
    env: process.env,
    fetchFn: (url, init) => fetch(url, init),
    which: (bin) => Bun.which(bin),
    run: async (argv) => {
      const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      return { code, stderr };
    },
    platform: process.platform,
  };
}

/** Replace every known secret value (API keys) in s with "[redacted]". */
export function redactSecrets(s: string, env: Env): string {
  let out = s;
  for (const k of ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "RECALL_API_KEY"]) {
    const v = env[k];
    if (v && v.length >= 4) out = out.split(v).join("[redacted]");
  }
  return out;
}

function mp3Encoder(deps: TtsDeps): "ffmpeg" | "lame" | null {
  if (deps.which("ffmpeg")) return "ffmpeg";
  if (deps.which("lame")) return "lame";
  return null;
}

function localAvailable(name: "macos" | "espeak", deps: TtsDeps): boolean {
  if (!mp3Encoder(deps)) return false;
  if (name === "macos") return deps.platform === "darwin" && deps.which("say") !== null;
  return deps.which("espeak-ng") !== null;
}

/** Pick the provider: explicit choice is validated; "auto" takes the first usable one. */
export function resolveProvider(requested: TtsProviderName | "auto", deps: TtsDeps): TtsProviderName {
  if (requested === "elevenlabs" && !deps.env.ELEVENLABS_API_KEY) {
    throw new TtsError("TTS provider 'elevenlabs' needs ELEVENLABS_API_KEY in the environment");
  }
  if (requested === "openai" && !deps.env.OPENAI_API_KEY) {
    throw new TtsError("TTS provider 'openai' needs OPENAI_API_KEY in the environment");
  }
  if (requested === "macos" && !localAvailable("macos", deps)) {
    throw new TtsError(
      "TTS provider 'macos' needs macOS `say` plus ffmpeg (with libmp3lame) or lame to encode MP3",
    );
  }
  if (requested === "espeak" && !localAvailable("espeak", deps)) {
    throw new TtsError("TTS provider 'espeak' needs espeak-ng plus ffmpeg (with libmp3lame) or lame");
  }
  if (requested !== "auto") return requested;
  if (deps.env.ELEVENLABS_API_KEY) return "elevenlabs";
  if (deps.env.OPENAI_API_KEY) return "openai";
  if (localAvailable("macos", deps)) return "macos";
  if (localAvailable("espeak", deps)) return "espeak";
  throw new TtsError(
    "no TTS provider available. Set ELEVENLABS_API_KEY or OPENAI_API_KEY, or install a local " +
      "engine: macOS `say` or espeak-ng, plus ffmpeg (libmp3lame) or lame for MP3 encoding",
  );
}

async function httpTts(
  label: string,
  url: string,
  init: RequestInit,
  deps: TtsDeps,
): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await deps.fetchFn(url, { ...init, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new TtsError(redactSecrets(`${label} TTS request failed: ${msg}`, deps.env));
  }
  if (!resp.ok) {
    const body = (await resp.text().catch(() => "")).slice(0, 300);
    throw new TtsError(redactSecrets(`${label} TTS failed: ${resp.status} ${body}`, deps.env));
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function synthOpenAI(text: string, cfg: TtsConfig, deps: TtsDeps): Promise<Uint8Array> {
  const speed = Math.min(4, Math.max(0.25, cfg.speed));
  return httpTts(
    "OpenAI",
    "https://api.openai.com/v1/audio/speech",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model || OPENAI_DEFAULT_MODEL,
        voice: cfg.voice || OPENAI_DEFAULT_VOICE,
        input: text,
        response_format: "mp3",
        speed,
      }),
    },
    deps,
  );
}

async function synthElevenLabs(text: string, cfg: TtsConfig, deps: TtsDeps): Promise<Uint8Array> {
  // ElevenLabs accepts voice_settings.speed in [0.7, 1.2].
  const speed = Math.min(1.2, Math.max(0.7, cfg.speed));
  const voice = encodeURIComponent(cfg.voice || ELEVENLABS_DEFAULT_VOICE);
  return httpTts(
    "ElevenLabs",
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": deps.env.ELEVENLABS_API_KEY ?? "",
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: cfg.model || ELEVENLABS_DEFAULT_MODEL,
        voice_settings: { speed },
      }),
    },
    deps,
  );
}

async function runOrThrow(argv: string[], label: string, deps: TtsDeps): Promise<void> {
  const r = await deps.run(argv);
  if (r.code !== 0) {
    throw new TtsError(`${label} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
}

async function synthLocal(
  name: "macos" | "espeak",
  text: string,
  cfg: TtsConfig,
  lang: SpeechLang,
  deps: TtsDeps,
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "samograph-tts-"));
  try {
    // Text goes through a file, never argv, so it can't be parsed as flags.
    const txt = join(dir, "in.txt");
    const wav = join(dir, "out.wav");
    const mp3 = join(dir, "out.mp3");
    writeFileSync(txt, text);
    const rate = String(Math.round(BASE_WPM * Math.min(2, Math.max(0.5, cfg.speed))));
    if (name === "macos") {
      const voice = cfg.voice || MACOS_DEFAULT_VOICE[lang];
      await runOrThrow(
        ["say", "-v", voice, "-r", rate, "-f", txt, "-o", wav, "--data-format=LEI16@22050"],
        "say",
        deps,
      );
    } else {
      const voice = cfg.voice || ESPEAK_DEFAULT_VOICE[lang];
      await runOrThrow(["espeak-ng", "-v", voice, "-s", rate, "-f", txt, "-w", wav], "espeak-ng", deps);
    }
    if (mp3Encoder(deps) === "ffmpeg") {
      await runOrThrow(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-ac", "1",
          "-c:a", "libmp3lame", "-b:a", "64k", mp3],
        "ffmpeg",
        deps,
      );
    } else {
      await runOrThrow(["lame", "--quiet", "-b", "64", wav, mp3], "lame", deps);
    }
    return new Uint8Array(readFileSync(mp3));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Synthesize one chunk of text to MP3 bytes with an already-resolved provider. */
export async function synthesize(
  provider: TtsProviderName,
  text: string,
  cfg: TtsConfig,
  lang: SpeechLang,
  deps: TtsDeps,
): Promise<Uint8Array> {
  switch (provider) {
    case "openai":
      return synthOpenAI(text, cfg, deps);
    case "elevenlabs":
      return synthElevenLabs(text, cfg, deps);
    case "macos":
    case "espeak":
      return synthLocal(provider, text, cfg, lang, deps);
  }
}
