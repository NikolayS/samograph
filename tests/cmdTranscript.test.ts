import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdTranscript } from "../src/commands/transcript.ts";
import type { RecallClient } from "../src/recall.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function makeRecall(bot: unknown): RecallClient {
  return {
    async leaveCall() { return new Response(); },
    async getBot() { return bot as Record<string, unknown>; },
    async sendChat() { return new Response(); },
    async screenshot() { return new Response(); },
    async createBot() { return { id: "x" }; },
  };
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise(async (resolve) => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { chunks.push(s); return true; };
    try { await fn(); } finally { (process.stdout.write as unknown) = orig; }
    resolve(chunks.join(""));
  });
}

describe("cmdTranscript", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    process.env.SAMOGRAPH_STATE_FILE = sf;
    process.env.RECALL_API_KEY = "fake-key";
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-abc" }));
  });
  afterEach(() => { restoreEnv(env); cleanupTmpDir(tmp); });

  it("no recordings — prints 'No recordings yet.' and falls back to local transcript", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "[2026-05-30 10:00:00] Alice: hello\n");
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-abc", transcript_file: tf }));

    const out = await captureStdout(() =>
      cmdTranscript({ command: "transcript", bot_id: null }, { recall: makeRecall({ recordings: [] }) })
    );
    expect(out).toContain("No recordings yet.");
    expect(out).toContain("Alice: hello");
  });

  it("recording with download_url — fetches and formats lines", async () => {
    const transcriptData = [
      { words: [{ text: "Hello", start_time: 1.0 }, { text: "world", start_time: 1.5 }], speaker: "Alice" },
      { words: [{ text: "Hi", start_time: 5.0 }], speaker: "Bob" },
    ];
    const fakeFetch: FetchFn = async () =>
      new Response(JSON.stringify(transcriptData), { status: 200, headers: { "content-type": "application/json" } });

    const bot = {
      recordings: [{
        media_shortcuts: {
          transcript: {
            status: { code: "done" },
            data: { download_url: "https://recall.ai/transcript/123" },
          },
        },
      }],
    };

    const out = await captureStdout(() =>
      cmdTranscript({ command: "transcript", bot_id: null }, { recall: makeRecall(bot), fetchFn: fakeFetch })
    );
    expect(out).toContain("[1.0s] Alice: Hello world");
    expect(out).toContain("[5.0s] Bob: Hi");
  });

  it("recording with download_url — returns cursor chunks without overlap", async () => {
    const transcriptData = [
      { words: [{ text: "one", start_time: 1.0 }], speaker: "Alice" },
      { words: [{ text: "two", start_time: 2.0 }], speaker: "Bob" },
      { words: [{ text: "three", start_time: 3.0 }], speaker: "Carol" },
    ];
    const fakeFetch: FetchFn = async () =>
      new Response(JSON.stringify(transcriptData), { status: 200, headers: { "content-type": "application/json" } });

    const bot = {
      recordings: [{
        media_shortcuts: {
          transcript: {
            status: { code: "done" },
            data: { download_url: "https://recall.ai/transcript/123" },
          },
        },
      }],
    };

    const out = await captureStdout(() =>
      cmdTranscript(
        { command: "transcript", bot_id: null, transcript_cursor: 1, transcript_limit: 1 },
        { recall: makeRecall(bot), fetchFn: fakeFetch },
      )
    );
    expect(out).not.toContain("one");
    expect(out).toContain("[2.0s] Bob: two");
    expect(out).not.toContain("three");
    expect(out).toContain("Next cursor: 2");
  });

  it("no recordings — can chunk the local transcript", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(tf, [
      "[2026-05-30 10:00:00] Alice: one",
      "[2026-05-30 10:00:01] Bob: two",
      "[2026-05-30 10:00:02] Carol: three",
      "",
    ].join("\n"));
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-abc", transcript_file: tf }));

    const out = await captureStdout(() =>
      cmdTranscript(
        { command: "transcript", bot_id: null, transcript_cursor: 2, transcript_limit: 10 },
        { recall: makeRecall({ recordings: [] }) },
      )
    );
    expect(out).toContain("No recordings yet.");
    expect(out).not.toContain("Alice: one");
    expect(out).toContain("Carol: three");
    expect(out).toContain("Next cursor: 3");
  });

  it("--file chunks a local transcript without requiring an active bot", async () => {
    const tf = join(tmp, "archived-transcript.txt");
    writeFileSync(tf, [
      "[2026-05-30 10:00:00] Alice: one",
      "[2026-05-30 10:00:01] Bob: two",
      "[2026-05-30 10:00:02] Carol: three",
      "",
    ].join("\n"));
    writeFileSync(sf, JSON.stringify({}));

    const out = await captureStdout(() =>
      cmdTranscript({
        command: "transcript",
        bot_id: null,
        transcript_file: tf,
        transcript_cursor: 1,
        transcript_limit: 2,
      })
    );
    expect(out).not.toContain("Alice: one");
    expect(out).toContain("Bob: two");
    expect(out).toContain("Carol: three");
    expect(out).toContain("Next cursor: 3");
  });

  it("recording present but no download_url — prints status code", async () => {
    const bot = {
      recordings: [{
        media_shortcuts: {
          transcript: {
            status: { code: "processing" },
          },
        },
      }],
    };

    const out = await captureStdout(() =>
      cmdTranscript({ command: "transcript", bot_id: null }, { recall: makeRecall(bot) })
    );
    expect(out).toContain("processing");
  });
});
