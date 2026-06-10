import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, utimesSync } from "node:fs";
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
    process.env.SAMOCALL_STATE_FILE = sf;
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
    const mtime = new Date("2026-05-30T10:00:06Z");
    utimesSync(tf, mtime, mtime);
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-test-123", transcript_file: tf }));

    const bot = { bot_name: "TARS", status_changes: [{ code: "in_call" }] };
    const out = await captureStdout(() =>
      cmdStatus({ command: "status", bot_id: null }, { recall: makeRecall(bot) })
    );
    expect(out).toContain("Transcript lines so far: 2");
    expect(out).toContain("Last transcript at: 2026-05-30T10:00:06.000Z");
    expect(out).toContain("Last transcript line: [2026-05-30 10:00:05] Bob: hi");
    expect(out).toContain(tf);
  });

  it("shows when the transcript file exists but has no transcript lines yet", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-test-123", transcript_file: tf }));

    const bot = { bot_name: "TARS", status_changes: [{ code: "in_call_recording" }] };
    const out = await captureStdout(() =>
      cmdStatus({ command: "status", bot_id: null }, { recall: makeRecall(bot) })
    );
    expect(out).toContain("Transcript lines so far: 0");
    expect(out).toContain("Last transcript line: none yet");
  });

  it("shows latest frame metadata when WebSocket frame capture is configured", async () => {
    writeFileSync(sf, JSON.stringify({
      bot_id: "bot-test-123",
      local_frame_metadata_url: "http://127.0.0.1:18080/frame.json",
      frame_token: "frame-secret",
    }));
    const seenHeaders: string[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push((init?.headers as Record<string, string>)["X-Samocall-Frame-Token"]);
      if (String(url).endsWith("/frames.json")) {
        return Response.json({ frames: [] });
      }
      return Response.json({
        type: "webcam",
        source_key: "participant:100",
        participant: { id: 100, name: "Nik - PostgresAI", is_host: true },
        timestamp: { absolute: "2026-06-04T00:48:16.443351Z" },
        updated_at: "2026-06-04T00:48:17.334Z",
        visual_status: "unknown",
      });
    };

    const bot = { bot_name: "TARS", status_changes: [{ code: "in_call_recording" }] };
    const out = await captureStdout(() =>
      cmdStatus({ command: "status", bot_id: null }, {
        recall: makeRecall(bot),
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    );

    expect(seenHeaders).toEqual(["frame-secret", "frame-secret"]);
    expect(out).toContain("Last frame at: 2026-06-04T00:48:16.443351Z");
    expect(out).toContain("Last frame source: webcam / Nik - PostgresAI");
    expect(out).toContain("Last frame source key: participant:100");
    expect(out).toContain("Last frame visual status: unknown");
    expect(out).toContain("Last frame received at: 2026-06-04T00:48:17.334Z");
  });

  it("shows when WebSocket frame capture has no frame yet", async () => {
    writeFileSync(sf, JSON.stringify({
      bot_id: "bot-test-123",
      local_frame_metadata_url: "http://127.0.0.1:18080/frame.json",
      frame_token: "frame-secret",
    }));
    const fetchFn = async () => Response.json({ error: "no frame" }, { status: 404 });

    const bot = { bot_name: "TARS", status_changes: [{ code: "in_call_recording" }] };
    const out = await captureStdout(() =>
      cmdStatus({ command: "status", bot_id: null }, {
        recall: makeRecall(bot),
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    );

    expect(out).toContain("Last frame: none yet");
  });
});
