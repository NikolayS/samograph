import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmdIntro,
  buildIntroMessage,
  firstHeardLine,
  postIntroOnJoin,
} from "../src/commands/intro.ts";
import { DEFAULT_INTRO_TEXT } from "../src/introText.ts";
import type { RecallClient } from "../src/recall.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

function captureChatRecall(sink: { botId?: string; message?: string }): RecallClient {
  return {
    async leaveCall() { return new Response(); },
    async getBot() { return {}; },
    async sendChat(botId: string, message: string) {
      sink.botId = botId;
      sink.message = message;
      return new Response("{}", { status: 200 });
    },
    async outputAudio() { return new Response("{}", { status: 200 }); },
    async screenshot() { return new Response(); },
    async createBot() { return { id: "x" }; },
  };
}

describe("buildIntroMessage", () => {
  it("uses the default text when no --intro-text", () => {
    const msg = buildIntroMessage({ command: "intro" });
    expect(msg).toBe(DEFAULT_INTRO_TEXT);
  });

  it("uses custom --intro-text when provided", () => {
    const msg = buildIntroMessage({ command: "intro", intro_text: "Hola, soy Leo." });
    expect(msg).toBe("Hola, soy Leo.");
  });

  it("falls back to default when --intro-text is blank", () => {
    const msg = buildIntroMessage({ command: "intro", intro_text: "   " });
    expect(msg).toBe(DEFAULT_INTRO_TEXT);
  });
});

describe("firstHeardLine / --context", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmp); });

  function writeTranscript(lines: string[]): string {
    const p = join(tmp, "transcript.txt");
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  it("returns the first real spoken line", () => {
    const p = writeTranscript([
      "[2026-06-18 17:50:02] Alice: Hello everyone.",
      "[2026-06-18 17:50:05] Bob: Hi.",
    ]);
    expect(firstHeardLine(p)).toEqual({ speaker: "Alice", text: "Hello everyone." });
  });

  it("skips SAMOGRAPH-WARNING lines", () => {
    const p = writeTranscript([
      "[2026-06-18 17:50:00] SAMOGRAPH-WARNING: tunnel unreachable (ERR_NGROK_727)",
      "[2026-06-18 17:50:02] Alice: First real line.",
    ]);
    expect(firstHeardLine(p)).toEqual({ speaker: "Alice", text: "First real line." });
  });

  it("returns null when there is no transcript yet", () => {
    expect(firstHeardLine(join(tmp, "missing.txt"))).toBeNull();
  });

  it("appends the first-heard tail when --context is set", () => {
    const p = writeTranscript(["[2026-06-18 17:50:02] Alice: Hello everyone."]);
    const msg = buildIntroMessage({ command: "intro", context: true }, p);
    expect(msg.startsWith(DEFAULT_INTRO_TEXT)).toBe(true);
    expect(msg).toContain('The first thing I heard was — Alice: "Hello everyone."');
  });

  it("omits the tail when --context is set but nothing was heard", () => {
    const msg = buildIntroMessage({ command: "intro", context: true }, join(tmp, "none.txt"));
    expect(msg).toBe(DEFAULT_INTRO_TEXT);
  });
});

describe("cmdIntro", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
    process.env.RECALL_API_KEY = "fake-key";
    writeFileSync(join(tmp, "state.json"), JSON.stringify({ bot_id: "bot-abc" }));
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("posts the default intro to chat using the state bot id", async () => {
    const sink: { botId?: string; message?: string } = {};
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    try {
      await cmdIntro({ command: "intro", bot_id: null }, { recall: captureChatRecall(sink) });
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(sink.botId).toBe("bot-abc");
    expect(sink.message).toBe(DEFAULT_INTRO_TEXT);
  });

  it("posts custom text with the context tail when requested", async () => {
    const transcript = join(tmp, "t.txt");
    writeFileSync(transcript, "[2026-06-18 17:50:02] Alice: Kickoff.\n");
    const sink: { botId?: string; message?: string } = {};
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    try {
      await cmdIntro(
        { command: "intro", bot_id: null, intro_text: "Hey, I'm the bot.", context: true },
        { recall: captureChatRecall(sink), transcriptPath: transcript },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(sink.message).toBe('Hey, I\'m the bot.\n\nThe first thing I heard was — Alice: "Kickoff."');
  });
});

describe("postIntroOnJoin", () => {
  function recallWithStatuses(statuses: string[], sentTo: string[]): RecallClient {
    let i = 0;
    return {
      async leaveCall() { return new Response(); },
      async getBot() {
        const code = statuses[Math.min(i, statuses.length - 1)];
        i += 1;
        return { status_changes: [{ code }] };
      },
      async sendChat(botId: string) { sentTo.push(botId); return new Response("{}", { status: 200 }); },
      async outputAudio() { return new Response("{}", { status: 200 }); },
      async screenshot() { return new Response(); },
      async createBot() { return { id: "x" }; },
    };
  }

  const noSleep = async () => {};

  it("posts once the bot is in the call", async () => {
    const sentTo: string[] = [];
    const recall = recallWithStatuses(["joining_call", "in_waiting_room", "in_call_recording"], sentTo);
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    let ok: boolean;
    try {
      ok = await postIntroOnJoin(recall, "bot-xyz", "hello", { tries: 5, sleepFn: noSleep });
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(ok).toBe(true);
    expect(sentTo).toEqual(["bot-xyz"]);
  });

  it("gives up without throwing when the bot never joins", async () => {
    const sentTo: string[] = [];
    const recall = recallWithStatuses(["in_waiting_room"], sentTo);
    const errs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errs.push(s); return true; };
    let ok: boolean;
    try {
      ok = await postIntroOnJoin(recall, "bot-xyz", "hello", { tries: 3, sleepFn: noSleep });
    } finally {
      (process.stderr.write as unknown) = origErr;
    }
    expect(ok).toBe(false);
    expect(sentTo).toEqual([]);
    expect(errs.join("")).toContain("samograph intro");
  });

  it("does not throw if getBot errors throughout", async () => {
    const recall: RecallClient = {
      async leaveCall() { return new Response(); },
      async getBot() { throw new Error("network"); },
      async sendChat() { return new Response("{}", { status: 200 }); },
      async outputAudio() { return new Response("{}", { status: 200 }); },
      async screenshot() { return new Response(); },
      async createBot() { return { id: "x" }; },
    };
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = () => true;
    let ok: boolean;
    try {
      ok = await postIntroOnJoin(recall, "bot-xyz", "hello", { tries: 2, sleepFn: noSleep });
    } finally {
      (process.stderr.write as unknown) = origErr;
    }
    expect(ok).toBe(false);
  });
});
