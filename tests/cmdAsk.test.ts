import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdAsk, chatQuestion, timeoutAnnouncement } from "../src/commands/ask.ts";
import type { RecallClient } from "../src/recall.ts";
import { parseArgs } from "../src/cli.ts";
import { formatInCallRules } from "../src/agentRules.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

function makeRecall(chat: string[], onChat?: (msg: string) => void, status = 200): RecallClient {
  return {
    async leaveCall() { return new Response(); },
    async getBot() { return {}; },
    async sendChat(_bid: string, msg: string) {
      chat.push(msg);
      onChat?.(msg);
      return new Response(status === 200 ? "{}" : "nope", { status });
    },
    async outputAudio() { return new Response("{}", { status: 200 }); },
    async screenshot() { return new Response(); },
    async createBot() { return { id: "x" }; },
  };
}

const T0 = Date.parse("2026-10-08T12:00:00Z");

function fakeClock() {
  let t = T0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += Math.max(ms, 1); },
  };
}

function quietStderr() {
  const e = process.stderr.write.bind(process.stderr);
  const err: string[] = [];
  (process.stderr.write as unknown) = (s: string) => { err.push(s); return true; };
  return { err, restore: () => { (process.stderr.write as unknown) = e; } };
}

describe("cmdAsk", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let transcript: string;

  const writeState = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        bot_id: "bot-abc",
        bot_name: "samoagent",
        agent_name: "samoagent",
        transcript_file: transcript,
        ...extra,
      }),
    );

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
    process.env.SAMOGRAPH_HOME = tmp;
    process.env.RECALL_API_KEY = "fake-key";
    transcript = join(tmp, "transcript.txt");
    // Lines before the question must never count as the answer.
    writeFileSync(transcript, "[2026-10-08 11:59:00] Alice: B\n");
    writeState();
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("returns the option a human picks by voice, in Russian ('второй')", async () => {
    const chat: string[] = [];
    const out: string[] = [];
    const recall = makeRecall(chat, (msg) => {
      if (chat.length === 1) {
        // The bot's own chat echo and its own speech must be ignored.
        appendFileSync(transcript, `[2026-10-08 12:00:00] samoagent (chat): ${msg.split("\n")[0]}\n`);
        appendFileSync(transcript, "[2026-10-08 12:00:01] samoagent: второй\n");
        appendFileSync(transcript, "[2026-10-08 12:00:02] SAMOGRAPH-WARNING: tunnel unreachable\n");
        appendFileSync(transcript, "[2026-10-08 12:00:03] Денис: Я думаю, второй\n");
      }
    });
    const clock = fakeClock();
    const q = quietStderr();
    let r;
    try {
      r = await cmdAsk(
        { command: "ask", message: "Какой вариант берём?", ask_options: ["A", "B", "C"], ask_timeout: 60 },
        { recall, now: clock.now, sleep: clock.sleep, write: (s) => out.push(s) },
      );
    } finally { q.restore(); }
    expect(r.answer).toBe("B");
    expect(r.by).toBe("Денис");
    expect(r.source).toBe("voice");
    expect(r.timed_out).toBe(false);
    expect(JSON.parse(out.join(""))).toMatchObject({ answer: "B", by: "Денис", source: "voice", timed_out: false });
    // Question posted in Russian with numbered options, then an acknowledgement.
    expect(chat[0]).toBe("Какой вариант берём?\nВарианты: 1) A  2) B  3) C\nОтветьте голосом или в чате.");
    expect(chat[1]).toBe("Принято: B (Денис).");
  });

  it("takes an answer from incoming meeting chat", async () => {
    const chat: string[] = [];
    const recall = makeRecall(chat, () => {
      if (chat.length === 1) appendFileSync(transcript, "[2026-10-08 12:00:04] Alice (chat): B\n");
    });
    const clock = fakeClock();
    const q = quietStderr();
    let r;
    try {
      r = await cmdAsk(
        { command: "ask", message: "Which plan?", ask_options: ["A", "B"], ask_timeout: 30 },
        { recall, now: clock.now, sleep: clock.sleep, write: () => {} },
      );
    } finally { q.restore(); }
    expect(r).toMatchObject({ answer: "B", by: "Alice", source: "chat", timed_out: false, text: "B" });
  });

  it("without options, the first human reply is the answer", async () => {
    const chat: string[] = [];
    const recall = makeRecall(chat);
    const clock = fakeClock();
    let n = 0;
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (++n === 3) appendFileSync(transcript, "[2026-10-08 12:00:05] Nik: Denis owns it\n");
    };
    const q = quietStderr();
    let r;
    try {
      r = await cmdAsk(
        { command: "ask", message: "Who owns the follow-up?", ask_timeout: 60 },
        { recall, now: clock.now, sleep, write: () => {} },
      );
    } finally { q.restore(); }
    expect(r).toMatchObject({ answer: "Denis owns it", by: "Nik", source: "voice", timed_out: false });
  });

  it("on timeout returns the default and announces it in the call", async () => {
    const chat: string[] = [];
    const spoken: string[] = [];
    writeState({ voice_enabled: true });
    const recall = makeRecall(chat, () => {
      if (chat.length === 1) {
        // Unmatched human talk is reported in `heard`, but is not an answer.
        appendFileSync(transcript, "[2026-10-08 12:00:02] Alice: hmm, let me think about the rollout\n");
      }
    });
    const clock = fakeClock();
    const out: string[] = [];
    const q = quietStderr();
    let r;
    try {
      r = await cmdAsk(
        {
          command: "ask", message: "Deploy now?", ask_options: ["yes", "no"],
          ask_timeout: 10, ask_default: "no", ask_voice: true,
        },
        {
          recall, now: clock.now, sleep: clock.sleep, write: (s) => out.push(s),
          speak: async (t) => { spoken.push(t); },
        },
      );
    } finally { q.restore(); }
    expect(r).toMatchObject({ answer: "no", by: null, source: null, timed_out: true, text: null });
    expect(r.heard).toEqual([{ by: "Alice", source: "voice", text: "hmm, let me think about the rollout" }]);
    expect(clock.now() - T0).toBeGreaterThanOrEqual(10_000);
    expect(clock.now() - T0).toBeLessThan(11_000);
    expect(chat[0]).toBe("Deploy now?\nOptions: 1) yes  2) no\nAnswer by voice or in chat (no answer in 10s: no).");
    expect(chat[1]).toBe("No answer in 10s. Going with: no.");
    expect(spoken).toEqual(["Deploy now? Options: yes or no.", "No answer in 10s. Going with: no."]);
    expect(JSON.parse(out.join("")).timed_out).toBe(true);
  });

  it("--voice without join --enable-voice falls back to chat only", async () => {
    const chat: string[] = [];
    const spoken: string[] = [];
    const clock = fakeClock();
    const q = quietStderr();
    try {
      await cmdAsk(
        { command: "ask", message: "Ready?", ask_timeout: 1, ask_voice: true },
        { recall: makeRecall(chat), now: clock.now, sleep: clock.sleep, write: () => {}, speak: async (t) => { spoken.push(t); } },
      );
    } finally { q.restore(); }
    expect(spoken).toEqual([]);
    expect(q.err.join("")).toContain("--voice ignored");
    expect(chat[1]).toBe("No answer in 1s. I'll decide myself and post it in the chat.");
  });

  it("fails loudly when the question cannot be posted", async () => {
    const clock = fakeClock();
    await expect(
      cmdAsk(
        { command: "ask", message: "Ready?", ask_timeout: 1 },
        { recall: makeRecall([], undefined, 500), now: clock.now, sleep: clock.sleep, write: () => {} },
      ),
    ).rejects.toThrow("send_chat_message failed: 500");
  });
});

describe("ask wording", () => {
  it("Russian timeout announcement", () => {
    expect(timeoutAnnouncement("A", 60, "ru")).toBe("Ответа нет за 60 с. Выбираю: A.");
  });
  it("chat question with a Russian default", () => {
    expect(chatQuestion("Берём?", ["да", "нет"], "да", 30, "ru")).toBe(
      "Берём?\nВарианты: 1) да  2) нет\nОтветьте голосом или в чате (через 30 с без ответа: да).",
    );
  });
});

describe("parseArgs ask", () => {
  it("parses flags", () => {
    const a = parseArgs(["ask", "Which", "one?", "--options", "A|B|C", "--timeout", "90", "--voice", "--default", "2"]);
    expect(a.message).toBe("Which one?");
    expect(a.ask_options).toEqual(["A", "B", "C"]);
    expect(a.ask_timeout).toBe(90);
    expect(a.ask_voice).toBe(true);
    expect(a.ask_default).toBe("2");
  });
  it("defaults to a 60 s timeout", () => {
    expect(parseArgs(["ask", "Ready?"]).ask_timeout).toBe(60);
  });
  it("rejects bad input", () => {
    expect(() => parseArgs(["ask"])).toThrow("question");
    expect(() => parseArgs(["ask", "Q", "--timeout", "0"])).toThrow("--timeout");
    expect(() => parseArgs(["ask", "Q", "--timeout", "3600"])).toThrow("--timeout");
    expect(() => parseArgs(["ask", "Q", "--options", "A"])).toThrow("at least two");
    expect(() => parseArgs(["ask", "Q", "--options", "A|B", "--default", "C"])).toThrow("--default");
  });
});

describe("join agent rules", () => {
  it("forbid blocking prompts and require asking through the call", () => {
    const rules = formatInCallRules();
    expect(rules).toContain("NEVER use blocking interactive prompts");
    expect(rules).toContain("AskUserQuestion");
    expect(rules).toContain("samograph ask");
    expect(rules).toContain("pick a sensible default and say it in the call");
    expect(rules).toContain("Read EVERY transcript line");
  });
});
