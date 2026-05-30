import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdStatus } from "../src/commands/status.ts";
import type { RecallClient } from "../src/recall.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

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

describe("cmdStatus", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    process.env.SAMOAGENT_STATE_FILE = sf;
    process.env.RECALL_API_KEY = "fake-key";
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-test-123" }));
  });
  afterEach(() => { restoreEnv(env); cleanupTmpDir(tmp); });

  it("shows bot id, name, and status from last status_change", async () => {
    const bot = { bot_name: "TARS 🔴", status_changes: [{ code: "joining" }, { code: "in_call" }] };
    const out = await captureStdout(() =>
      cmdStatus({ command: "status", bot_id: null }, { recall: makeRecall(bot) })
    );
    expect(out).toContain("bot-test-123");
    expect(out).toContain("TARS 🔴");
    expect(out).toContain("in_call");
  });

  it("shows 'joining' when status_changes is empty", async () => {
    const bot = { bot_name: "TARS 🔴", status_changes: [] };
    const out = await captureStdout(() =>
      cmdStatus({ command: "status", bot_id: null }, { recall: makeRecall(bot) })
    );
    expect(out).toContain("joining");
  });

  it("shows transcript line count when transcript file exists", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "[2026-05-30 10:00:00] Alice: hello\n[2026-05-30 10:00:05] Bob: hi\n");
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-test-123", transcript_file: tf }));

    const bot = { bot_name: "TARS", status_changes: [{ code: "in_call" }] };
    const out = await captureStdout(() =>
      cmdStatus({ command: "status", bot_id: null }, { recall: makeRecall(bot) })
    );
    expect(out).toContain("Transcript lines so far: 2");
    expect(out).toContain(tf);
  });
});
