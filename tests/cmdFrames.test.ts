import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdFrames } from "../src/commands/frames.ts";
import { ExitError } from "../src/config.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise(async (resolve) => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { chunks.push(s); return true; };
    try { await fn(); } finally { (process.stdout.write as unknown) = orig; }
    resolve(chunks.join(""));
  });
}

describe("cmdFrames", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    process.env.SAMOGRAPH_STATE_FILE = sf;
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("lists buffered WebSocket frame sources", async () => {
    writeFileSync(sf, JSON.stringify({
      local_frame_metadata_url: "http://127.0.0.1:18080/frame.json",
      frame_token: "frame-secret",
    }));
    const seen: Array<{ url: string; headers?: RequestInit["headers"] }> = [];
    const out = await captureStdout(() => cmdFrames({
      fetchFn: async (url, init) => {
        seen.push({ url: String(url), headers: init?.headers });
        return Response.json({
          frames: [{
            source_key: "type:screen_share",
            type: "screen_share",
            participant: { id: "screen", name: "Screen" },
            timestamp: { absolute: "2026-06-04T01:00:00Z" },
            raw_bytes: 123456,
            visual_status: "unknown",
          }],
        });
      },
    }));

    expect(seen[0]?.url).toBe("http://127.0.0.1:18080/frames.json");
    expect(seen[0]?.headers).toEqual({ "X-Samograph-Frame-Token": "frame-secret" });
    expect(out).toContain("type:screen_share");
    expect(out).toContain("screen_share");
    expect(out).toContain("123456 bytes");
  });

  it("exits when WebSocket frame capture is not active", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-test" }));
    await expect(cmdFrames()).rejects.toBeInstanceOf(ExitError);
  });
});
