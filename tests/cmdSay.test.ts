import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdSay, BargeInWatcher, RECALL_OUTPUT_AUDIO_MAX_B64 } from "../src/commands/say.ts";
import type { RecallClient } from "../src/recall.ts";
import type { TtsDeps } from "../src/tts.ts";
import { parseArgs } from "../src/cli.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

const OPENAI_KEY = "sk-test-SECRET-openai-0123456789";
const ELEVEN_KEY = "el-test-SECRET-eleven-0123456789";

interface RecallLog {
  events: string[];
  audio: string[];
  chat: string[];
}

function makeRecall(
  log: RecallLog,
  opts: { audioStatus?: number; onAudio?: (n: number) => void } = {},
): RecallClient {
  return {
    async leaveCall() { return new Response(); },
    async getBot() { return {}; },
    async sendChat(_bid: string, msg: string) {
      log.events.push("chat");
      log.chat.push(msg);
      return new Response("{}", { status: 200 });
    },
    async outputAudio(_bid: string, b64: string) {
      log.events.push("audio");
      log.audio.push(Buffer.from(b64, "base64").toString());
      opts.onAudio?.(log.audio.length);
      const status = opts.audioStatus ?? 200;
      return new Response(status === 200 ? "{}" : "bad request", { status });
    },
    async stopOutputAudio() {
      log.events.push("stop");
      return new Response(null, { status: 204 });
    },
    async screenshot() { return new Response(); },
    async createBot() { return { id: "x" }; },
  };
}

// Fake OpenAI TTS: returns the input text as the "MP3" bytes.
function makeTts(env: Record<string, string | undefined> = { OPENAI_API_KEY: OPENAI_KEY }): {
  deps: TtsDeps;
  requests: { url: string; init?: RequestInit }[];
} {
  const requests: { url: string; init?: RequestInit }[] = [];
  return {
    requests,
    deps: {
      env,
      fetchFn: async (url, init) => {
        requests.push({ url, init });
        const body = JSON.parse(String(init?.body)) as { input?: string; text?: string };
        return new Response(body.input ?? body.text ?? "", { status: 200 });
      },
      which: () => null,
      run: async () => ({ code: 0, stderr: "" }),
      platform: "linux",
    },
  };
}

function fakeClock() {
  let t = Date.parse("2026-10-08T12:00:00Z");
  return {
    now: () => t,
    sleep: async (ms: number) => { t += Math.max(ms, 1); },
    advance: (ms: number) => { t += ms; },
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (s: string) => { out.push(s); return true; };
  (process.stderr.write as unknown) = (s: string) => { err.push(s); return true; };
  return {
    out,
    err,
    restore: () => {
      (process.stdout.write as unknown) = o;
      (process.stderr.write as unknown) = e;
    },
  };
}

describe("cmdSay", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let transcript: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
    process.env.SAMOGRAPH_HOME = tmp;
    process.env.RECALL_API_KEY = "fake-key";
    transcript = join(tmp, "transcript.txt");
    writeFileSync(transcript, "[2026-10-08 11:59:00] Alice: earlier line\n");
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({ bot_id: "bot-abc", bot_name: "samoagent", transcript_file: transcript }),
    );
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("plays each sentence sequentially via output_audio, waiting for each clip", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const tts = makeTts();
    const audioTimes: number[] = [];
    const recall = makeRecall(log, { onAudio: () => audioTimes.push(clock.now()) });
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "First sentence. Second one! Third?" },
        { recall, tts: tts.deps, now: clock.now, sleep: clock.sleep, durationOf: () => 2 },
      );
    } finally { cap.restore(); }
    expect(log.audio).toEqual(["First sentence.", "Second one!", "Third?"]);
    expect(log.chat).toEqual([]);
    // Each next clip starts only after the previous clip's duration (2 s).
    expect(audioTimes[1]! - audioTimes[0]!).toBeGreaterThanOrEqual(2000);
    expect(audioTimes[2]! - audioTimes[1]!).toBeGreaterThanOrEqual(2000);
    expect(cap.out.join("")).toContain("Said (3/3 chunk(s), provider openai, policy full)");
  });

  it("OpenAI request carries voice/model/speed and the key only in the header", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const tts = makeTts();
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "Hi.", voice: "nova", tts_model: "tts-1", tts_speed: 1.25 },
        { recall: makeRecall(log), tts: tts.deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } finally { cap.restore(); }
    const req = tts.requests[0]!;
    expect(req.url).toBe("https://api.openai.com/v1/audio/speech");
    expect((req.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    const body = JSON.parse(String(req.init?.body));
    expect(body).toEqual({ model: "tts-1", voice: "nova", input: "Hi.", response_format: "mp3", speed: 1.25 });
    expect(String(req.init?.body)).not.toContain(OPENAI_KEY);
  });

  it("prefers ElevenLabs when ELEVENLABS_API_KEY is set; voice id goes in the path", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const tts = makeTts({ ELEVENLABS_API_KEY: ELEVEN_KEY, OPENAI_API_KEY: OPENAI_KEY, SAMOGRAPH_TTS_VOICE: "voice123" });
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "Hi." },
        { recall: makeRecall(log), tts: tts.deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } finally { cap.restore(); }
    const req = tts.requests[0]!;
    expect(req.url).toStartWith("https://api.elevenlabs.io/v1/text-to-speech/voice123?");
    expect((req.init?.headers as Record<string, string>)["xi-api-key"]).toBe(ELEVEN_KEY);
    expect(JSON.parse(String(req.init?.body)).model_id).toBe("eleven_multilingual_v2");
  });

  it("long text: speaks a short ask and posts the full text to chat first (default ask-first)", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i} of the note.`).join(" ");
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: long, topic: "the rollback plan" },
        { recall: makeRecall(log), tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 1 },
      );
    } finally { cap.restore(); }
    expect(log.events[0]).toBe("chat");
    expect(log.chat).toEqual([long]);
    expect(log.audio.join(" ")).toBe(
      "I have a longer note on the rollback plan. I posted it in the chat. Want me to read it out?",
    );
    expect(cap.err.join("")).toContain("limit 40");
  });

  it("long text with --truncate speaks only the leading sentences within the limit", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const long = "One two three four. Five six seven eight. Nine ten eleven twelve.";
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: long, max_words: 9, long_mode: "truncate" },
        { recall: makeRecall(log), tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 1 },
      );
    } finally { cap.restore(); }
    expect(log.audio).toEqual(["One two three four.", "Five six seven eight."]);
    expect(log.chat).toEqual([long]);
  });

  it("--max-words 0 speaks everything; Russian ask line is used for Russian text", async () => {
    const clock = fakeClock();
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "Раз два три. Четыре пять шесть.", max_words: 2 },
        { recall: makeRecall(log), tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } finally { cap.restore(); }
    expect(log.audio.join(" ")).toContain("Зачитать вслух?");

    const log2: RecallLog = { events: [], audio: [], chat: [] };
    const cap2 = capture();
    try {
      await cmdSay(
        { command: "say", message: "One two three. Four five six.", max_words: 0, priority: "high" },
        { recall: makeRecall(log2), tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } finally { cap2.restore(); }
    expect(log2.audio).toEqual(["One two three.", "Four five six."]);
  });

  it("--also-chat posts the text to chat too", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "Short note.", also_chat: true },
        { recall: makeRecall(log), tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } finally { cap.restore(); }
    expect(log.chat).toEqual(["Short note."]);
    expect(log.audio).toEqual(["Short note."]);
  });

  it("cooldown refuses a normal-priority say; --priority high bypasses it", async () => {
    const clock = fakeClock();
    const deps = () => ({ tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 1 });
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const cap = capture();
    try {
      await cmdSay({ command: "say", message: "One." }, { recall: makeRecall(log), ...deps() });
      clock.advance(5000);
      let err = "";
      try {
        await cmdSay({ command: "say", message: "Two." }, { recall: makeRecall(log), ...deps() });
      } catch (e) { err = (e as Error).message; }
      expect(err).toContain("cooldown");
      expect(err).toContain("--priority high");
      await cmdSay({ command: "say", message: "Urgent.", priority: "high" }, { recall: makeRecall(log), ...deps() });
      clock.advance(16000);
      await cmdSay({ command: "say", message: "Three." }, { recall: makeRecall(log), ...deps() });
    } finally { cap.restore(); }
    expect(log.audio).toEqual(["One.", "Urgent.", "Three."]);
  });

  it("barge-in: a new human transcript line stops the remaining sentences and stops Recall audio", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const recall = makeRecall(log, {
      onAudio: (n) => {
        if (n === 1) {
          // The bot's own name and chat lines must not count as barge-in.
          appendFileSync(transcript, "[2026-10-08 12:00:00] samoagent: echo\n");
          appendFileSync(transcript, "[2026-10-08 12:00:00] Bob (chat): typed\n");
          appendFileSync(transcript, "[2026-10-08 12:00:01] Denis: wait, a question\n");
        }
      },
    });
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "One. Two. Three." },
        { recall, tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 3 },
      );
    } finally { cap.restore(); }
    expect(log.audio).toEqual(["One."]);
    expect(log.events).toContain("stop");
    expect(cap.out.join("")).toContain("Interrupted (barge-in by Denis) after 1/3");
  });

  it("--no-barge-in ignores transcript lines", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const recall = makeRecall(log, {
      onAudio: () => appendFileSync(transcript, "[2026-10-08 12:00:01] Denis: hi\n"),
    });
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "One. Two.", no_barge_in: true },
        { recall, tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 1 },
      );
    } finally { cap.restore(); }
    expect(log.audio).toEqual(["One.", "Two."]);
  });

  it("say --stop interrupts a running say (stop file) and calls Recall stop", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    let stopped = false;
    const recall = makeRecall(log, {
      onAudio: () => {
        if (!stopped) {
          stopped = true;
          // Simulate `samograph say --stop` from another process.
          void cmdSay({ command: "say", say_stop: true }, { recall, now: clock.now, pidAlive: () => true });
        }
      },
    });
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "One. Two. Three." },
        { recall, tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 3 },
      );
    } finally { cap.restore(); }
    expect(log.audio).toEqual(["One."]);
    expect(cap.out.join("")).toContain("Interrupted (say --stop)");
    expect(existsSync(join(tmp, ".samograph", "say.stop"))).toBe(false);
    expect(existsSync(join(tmp, ".samograph", "say.lock.json"))).toBe(false);
  });

  it("refuses to start while another say is speaking", async () => {
    const dir = join(tmp, ".samograph");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "say.lock.json"), JSON.stringify({ pid: 999999, started_at: 1 }));
    let err = "";
    try {
      await cmdSay(
        { command: "say", message: "Hi." },
        { recall: makeRecall({ events: [], audio: [], chat: [] }), tts: makeTts().deps, pidAlive: () => true },
      );
    } catch (e) { err = (e as Error).message; }
    expect(err).toContain("already speaking (pid 999999)");
  });

  it("sets presence to speaking while playing, then back to listening", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        bot_id: "bot-abc",
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_write_token: "w",
      }),
    );
    const states: string[] = [];
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const clock = fakeClock();
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "Hi." },
        {
          recall: makeRecall(log),
          tts: makeTts().deps,
          now: clock.now,
          sleep: clock.sleep,
          durationOf: () => 1,
          fetchFn: async (_u, init) => {
            states.push(JSON.parse(String(init?.body)).state);
            return new Response("{}");
          },
        },
      );
    } finally { cap.restore(); }
    expect(states).toEqual(["speaking", "listening"]);
  });

  it("output_audio 400 fails with a hint to join --enable-voice", async () => {
    const clock = fakeClock();
    let err = "";
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "Hi." },
        { recall: makeRecall({ events: [], audio: [], chat: [] }, { audioStatus: 400 }), tts: makeTts().deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } catch (e) { err = (e as Error).message; } finally { cap.restore(); }
    expect(err).toContain("output_audio failed: 400");
    expect(err).toContain("--enable-voice");
  });

  it("rejects a chunk larger than Recall's output_audio limit", async () => {
    const clock = fakeClock();
    const tts = makeTts();
    tts.deps.fetchFn = async () => new Response(new Uint8Array(RECALL_OUTPUT_AUDIO_MAX_B64), { status: 200 });
    let err = "";
    try {
      await cmdSay(
        { command: "say", message: "Hi." },
        { recall: makeRecall({ events: [], audio: [], chat: [] }), tts: tts.deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } catch (e) { err = (e as Error).message; }
    expect(err).toContain("too large for Recall output_audio");
  });

  it("no provider available -> clear error", async () => {
    const tts = makeTts({});
    let err = "";
    try {
      await cmdSay({ command: "say", message: "Hi." }, { recall: makeRecall({ events: [], audio: [], chat: [] }), tts: tts.deps });
    } catch (e) { err = (e as Error).message; }
    expect(err).toContain("no TTS provider available");
    expect(err).toContain("ELEVENLABS_API_KEY");
  });

  it("never leaks API keys: provider error bodies echoing the key are redacted", async () => {
    const tts = makeTts({ OPENAI_API_KEY: OPENAI_KEY });
    tts.deps.fetchFn = async () =>
      new Response(`{"error":"Incorrect API key provided: ${OPENAI_KEY}"}`, { status: 401 });
    const clock = fakeClock();
    let err = "";
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "Hi." },
        { recall: makeRecall({ events: [], audio: [], chat: [] }), tts: tts.deps, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) { err = (e as Error).message; } finally { cap.restore(); }
    expect(err).toContain("OpenAI TTS failed: 401");
    expect(err).toContain("[redacted]");
    expect(err).not.toContain(OPENAI_KEY);
    expect(cap.out.join("") + cap.err.join("")).not.toContain(OPENAI_KEY);
  });

  it("successful runs print nothing containing API keys", async () => {
    const tts = makeTts({ ELEVENLABS_API_KEY: ELEVEN_KEY, OPENAI_API_KEY: OPENAI_KEY });
    const clock = fakeClock();
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "A fairly long note. ".repeat(30), also_chat: true },
        { recall: makeRecall({ events: [], audio: [], chat: [] }), tts: tts.deps, now: clock.now, sleep: clock.sleep, durationOf: () => 0 },
      );
    } finally { cap.restore(); }
    const all = cap.out.join("") + cap.err.join("");
    expect(all).not.toContain(ELEVEN_KEY);
    expect(all).not.toContain(OPENAI_KEY);
  });

  it("--out writes the MP3 and touches neither Recall nor chat", async () => {
    const log: RecallLog = { events: [], audio: [], chat: [] };
    const out = join(tmp, "a.mp3");
    const cap = capture();
    try {
      await cmdSay(
        { command: "say", message: "One. Two.", out },
        { recall: makeRecall(log), tts: makeTts().deps, durationOf: () => 0 },
      );
    } finally { cap.restore(); }
    expect(readFileSync(out, "utf-8")).toBe("One.Two.");
    expect(log.events).toEqual([]);
  });
});

describe("BargeInWatcher", () => {
  it("ignores lines that started before playback and warning lines", () => {
    const tmp = makeTmpDir();
    try {
      const f = join(tmp, "t.txt");
      writeFileSync(f, "");
      const w = new BargeInWatcher(f, Date.parse("2026-10-08T12:00:00.500Z"), "bot");
      appendFileSync(f, "[2026-10-08 11:59:58] Alice: late delivery of an old line\n");
      appendFileSync(f, "[2026-10-08 12:00:05] SAMOGRAPH-WARNING: tunnel unreachable\n");
      expect(w.poll()).toBeNull();
      appendFileSync(f, "[2026-10-08 12:00:06] Alice: partial");
      expect(w.poll()).toBeNull(); // incomplete line
      appendFileSync(f, " line\n");
      expect(w.poll()).toBe("Alice");
    } finally {
      cleanupTmpDir(tmp);
    }
  });
});

describe("parseArgs say", () => {
  it("parses flags", () => {
    const a = parseArgs([
      "say", "Hello", "world", "--voice", "nova", "--lang", "en", "--also-chat",
      "--provider", "openai", "--speed", "1.2", "--max-words", "0", "--priority", "high",
      "--truncate", "--cooldown", "5", "--no-barge-in",
    ]);
    expect(a.message).toBe("Hello world");
    expect(a.voice).toBe("nova");
    expect(a.lang).toBe("en");
    expect(a.also_chat).toBe(true);
    expect(a.tts_provider).toBe("openai");
    expect(a.tts_speed).toBe(1.2);
    expect(a.max_words).toBe(0);
    expect(a.priority).toBe("high");
    expect(a.long_mode).toBe("truncate");
    expect(a.cooldown).toBe(5);
    expect(a.no_barge_in).toBe(true);
  });

  it("--stop needs no text; text is otherwise required", () => {
    expect(parseArgs(["say", "--stop"]).say_stop).toBe(true);
    expect(() => parseArgs(["say"])).toThrow("required: text");
  });

  it("rejects invalid values", () => {
    expect(() => parseArgs(["say", "x", "--lang", "de"])).toThrow("--lang");
    expect(() => parseArgs(["say", "x", "--provider", "polly"])).toThrow("--provider");
    expect(() => parseArgs(["say", "x", "--priority", "urgent"])).toThrow("--priority");
    expect(() => parseArgs(["say", "x", "--speed", "0"])).toThrow("--speed");
    expect(() => parseArgs(["say", "x", "--max-words", "1.5"])).toThrow("--max-words");
    expect(() => parseArgs(["say", "x", "--truncate", "--ask-first"])).toThrow("--truncate");
  });

  it("join --enable-voice", () => {
    expect(parseArgs(["join", "https://meet.google.com/x", "--enable-voice"]).enable_voice).toBe(true);
    expect(parseArgs(["join", "https://meet.google.com/x"]).enable_voice).toBe(false);
  });
});
