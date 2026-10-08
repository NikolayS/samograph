import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  chunkText,
  countWords,
  detectLang,
  planSpeech,
  splitSentences,
  truncateToWords,
} from "../src/speech.ts";
import { mp3DurationSeconds } from "../src/mp3.ts";
import { SILENT_MP3_B64 } from "../src/silentMp3.ts";
import { redactSecrets, resolveProvider, synthesize, type TtsDeps } from "../src/tts.ts";

describe("speech text policy", () => {
  it("detects language", () => {
    expect(detectLang("Привет, как дела?")).toBe("ru");
    expect(detectLang("Hello there")).toBe("en");
    expect(detectLang("Привет", "en")).toBe("en");
  });

  it("splits sentences and chunks long ones at clause boundaries", () => {
    expect(splitSentences("One. Two!  Three?\nFour")).toEqual(["One.", "Two!", "Three?", "Four"]);
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(long, 25);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => countWords(c) <= 25)).toBe(true);
    expect(chunkText("a b c, d e f, g h", 4)).toEqual(["a b c,", "d e f,", "g h"]);
  });

  it("truncates to whole leading sentences; word-caps a too-long first sentence", () => {
    expect(truncateToWords("A b c. D e f. G h i.", 6)).toBe("A b c. D e f.");
    expect(truncateToWords("A b c d e f g.", 3)).toBe("A b c…");
  });

  it("plans full / ask / truncate", () => {
    const base = { maxWords: 5, longMode: "ask" as const, alsoChat: false, lang: "en" as const };
    expect(planSpeech("Short one.", base)).toMatchObject({ policy: "full", chat: null });
    expect(planSpeech("Short one.", { ...base, alsoChat: true }).chat).toBe("Short one.");
    const long = "This text has more than five words in it.";
    expect(planSpeech(long, base)).toMatchObject({ policy: "ask", chat: long });
    expect(planSpeech(long, { ...base, askText: "Go on?" }).spoken).toBe("Go on?");
    expect(planSpeech(long, { ...base, longMode: "truncate" }).policy).toBe("truncate");
    expect(planSpeech(long, { ...base, maxWords: 0 }).policy).toBe("full");
  });
});

describe("mp3 duration", () => {
  it("estimates the silent clip at ~0.2 s and returns 0 for non-MP3", () => {
    const d = mp3DurationSeconds(Buffer.from(SILENT_MP3_B64, "base64"));
    expect(d).toBeGreaterThan(0.15);
    expect(d).toBeLessThan(0.35);
    expect(mp3DurationSeconds(new TextEncoder().encode("not audio"))).toBe(0);
  });
});

function deps(over: Partial<TtsDeps> = {}): TtsDeps {
  return {
    env: {},
    fetchFn: async () => new Response(""),
    which: () => null,
    run: async () => ({ code: 0, stderr: "" }),
    platform: "darwin",
    ...over,
  };
}

describe("tts providers", () => {
  it("auto order: elevenlabs > openai > macos > espeak", () => {
    expect(resolveProvider("auto", deps({ env: { ELEVENLABS_API_KEY: "k1", OPENAI_API_KEY: "k2" } }))).toBe("elevenlabs");
    expect(resolveProvider("auto", deps({ env: { OPENAI_API_KEY: "k2" } }))).toBe("openai");
    const all = (b: string) => `/bin/${b}`;
    expect(resolveProvider("auto", deps({ which: all }))).toBe("macos");
    expect(resolveProvider("auto", deps({ which: all, platform: "linux" }))).toBe("espeak");
  });

  it("local engines need an MP3 encoder; explicit providers need their key", () => {
    const noEncoder = (b: string) => (b === "say" ? "/usr/bin/say" : null);
    expect(() => resolveProvider("auto", deps({ which: noEncoder }))).toThrow("no TTS provider available");
    expect(() => resolveProvider("macos", deps({ which: noEncoder }))).toThrow("ffmpeg");
    expect(() => resolveProvider("openai", deps())).toThrow("OPENAI_API_KEY");
    expect(() => resolveProvider("elevenlabs", deps())).toThrow("ELEVENLABS_API_KEY");
  });

  it("macOS path passes text via a file (never argv) and encodes with ffmpeg", async () => {
    const calls: string[][] = [];
    const d = deps({
      which: (b) => `/bin/${b}`,
      run: async (argv) => {
        calls.push(argv);
        if (argv[0] === "ffmpeg") writeFileSync(argv[argv.length - 1]!, "MP3");
        return { code: 0, stderr: "" };
      },
    });
    const out = await synthesize("macos", "--rm -rf hello", { provider: "macos", voice: null, model: null, speed: 1 }, "ru", d);
    expect(new TextDecoder().decode(out)).toBe("MP3");
    expect(calls[0]![0]).toBe("say");
    expect(calls[0]).toContain("Milena");
    expect(calls[0]).toContain("-f");
    expect(calls.flat()).not.toContain("--rm -rf hello");
    expect(calls[1]![0]).toBe("ffmpeg");
  });

  it("local engine failure surfaces a clear error", async () => {
    const d = deps({ which: (b) => `/bin/${b}`, run: async () => ({ code: 1, stderr: "Voice not found" }) });
    await expect(
      synthesize("macos", "hi", { provider: "macos", voice: "Nope", model: null, speed: 1 }, "en", d),
    ).rejects.toThrow("say failed (exit 1): Voice not found");
  });

  it("redactSecrets masks every configured key", () => {
    const env = { OPENAI_API_KEY: "sk-abc123", ELEVENLABS_API_KEY: "el-xyz789", RECALL_API_KEY: "rc-000111" };
    expect(redactSecrets("a sk-abc123 b el-xyz789 c rc-000111", env)).toBe("a [redacted] b [redacted] c [redacted]");
  });
});
