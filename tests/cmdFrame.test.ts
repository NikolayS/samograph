import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExitError } from "../src/config.ts";
import { cmdFrame } from "../src/commands/frame.ts";
import type { RecallClient } from "../src/recall.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

function recallWithScreenshot(resp: Response): RecallClient {
  return {
    async leaveCall() {
      return new Response();
    },
    async getBot() {
      return {};
    },
    async sendChat() {
      return new Response();
    },
    async screenshot() {
      return resp;
    },
    async createBot() {
      return { id: "x" };
    },
  };
}

function imageResponse(
  bytes: Uint8Array,
  contentType: string,
  status = 200,
): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": contentType },
  });
}

describe("cmdFrame — no RTMP", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    process.env.SAMOAGENT_STATE_FILE = sf;
    process.env.RECALL_API_KEY = "fake-key";
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("tries recall screenshot when no rtmp", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-123" }));
    const out = join(tmp, "frame.png");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await cmdFrame(
      { command: "frame", out, bot_id: null },
      { recall: recallWithScreenshot(imageResponse(png, "image/png")) },
    );
    expect(existsSync(out)).toBe(true);
    expect(new Uint8Array(readFileSync(out))).toEqual(png);
  });

  it("writes image to file on success", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-img" }));
    const out = join(tmp, "frame.png");
    const data = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...new Array(100).fill(0),
    ]);
    await cmdFrame(
      { command: "frame", out, bot_id: null },
      { recall: recallWithScreenshot(imageResponse(data, "image/png")) },
    );
    expect(new Uint8Array(readFileSync(out))).toEqual(data);
  });

  it("exits when not image content type", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-noimg" }));
    const out = join(tmp, "frame.png");
    let code = -1;
    try {
      await cmdFrame(
        { command: "frame", out, bot_id: null },
        {
          recall: recallWithScreenshot(
            imageResponse(new Uint8Array([0x7b, 0x7d]), "application/json"),
          ),
        },
      );
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("exits when not 200", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-404" }));
    const out = join(tmp, "frame.png");
    let code = -1;
    try {
      await cmdFrame(
        { command: "frame", out, bot_id: null },
        {
          recall: recallWithScreenshot(
            imageResponse(new Uint8Array(), "application/json", 404),
          ),
        },
      );
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("frame unavailable on 503", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-err" }));
    const out = join(tmp, "frame.png");
    let threw = false;
    try {
      await cmdFrame(
        { command: "frame", out, bot_id: null },
        {
          recall: recallWithScreenshot(
            imageResponse(new Uint8Array(), "text/plain", 503),
          ),
        },
      );
    } catch (e) {
      threw = e instanceof ExitError;
    }
    expect(threw).toBe(true);
  });

  it("prints path on success", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-ok" }));
    const out = join(tmp, "frame.png");
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      await cmdFrame(
        { command: "frame", out, bot_id: null },
        {
          recall: recallWithScreenshot(
            imageResponse(new Uint8Array([0x4a]), "image/jpeg"),
          ),
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(writes.join("")).toContain(resolve(out));
  });

  it("fetches WebSocket PNG from local frame server on demand", async () => {
    const out = join(tmp, "out.png");
    writeFileSync(
      sf,
      JSON.stringify({
        local_frame_url: "http://127.0.0.1:18080/frame",
        local_frame_metadata_url: "http://127.0.0.1:18080/frame.json",
        frame_token: "secret-token",
        video_frame_file: join(tmp, "latest.png"),
      }),
    );
    const calls: Array<{ url: string; headers?: RequestInit["headers"] }> = [];

    await cmdFrame(
      { command: "frame", out, bot_id: null },
      {
        fetchFn: async (url, init) => {
          calls.push({ url: String(url), headers: init?.headers });
          if (String(url).endsWith("/frame.json")) {
            return Response.json({
              call_id: "bot-123",
              type: "webcam",
              participant: { id: "p1" },
              timestamp: { absolute: "2026-05-30T15:00:00Z" },
            });
          }
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          });
        },
      },
    );

    expect(new Uint8Array(readFileSync(out))).toEqual(new Uint8Array([1, 2, 3]));
    expect(readFileSync(out.replace(/\.png$/, ".json"), "utf-8")).toContain("bot-123");
    expect(calls[0]?.headers).toEqual({ "X-Samoagent-Frame-Token": "secret-token" });
    expect(calls[1]?.headers).toEqual({ "X-Samoagent-Frame-Token": "secret-token" });
    expect(existsSync(join(tmp, "latest.png"))).toBe(false);
  });

  it("writes metadata as sibling when --out has no extension", async () => {
    const out = join(tmp, "nested.with.dot", "frame");
    writeFileSync(
      sf,
      JSON.stringify({
        local_frame_url: "http://127.0.0.1:18080/frame",
        local_frame_metadata_url: "http://127.0.0.1:18080/frame.json",
        frame_token: "secret-token",
      }),
    );

    await cmdFrame(
      { command: "frame", out, bot_id: null },
      {
        fetchFn: async (url) => {
          if (String(url).endsWith("/frame.json")) {
            return Response.json({ call_id: "bot-123" });
          }
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          });
        },
      },
    );

    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out + ".json", "utf-8")).toContain("bot-123");
  });

  it("does not chmod existing explicit --out directory", async () => {
    const publicDir = join(tmp, "public");
    mkdirSync(publicDir);
    chmodSync(publicDir, 0o755);
    const out = join(publicDir, "frame.png");
    writeFileSync(
      sf,
      JSON.stringify({
        local_frame_url: "http://127.0.0.1:18080/frame",
        frame_token: "secret-token",
      }),
    );

    await cmdFrame(
      { command: "frame", out, bot_id: null },
      {
        fetchFn: async () => new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      },
    );

    expect(statSync(publicDir).mode & 0o777).toBe(0o755);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("archives WebSocket PNG only when requested", async () => {
    writeFileSync(
      sf,
      JSON.stringify({
        local_frame_url: "http://127.0.0.1:18080/frame",
        local_frame_metadata_url: "http://127.0.0.1:18080/frame.json",
        frame_token: "secret-token",
        video_frame_dir: tmp,
        video_frame_file: join(tmp, "latest.png"),
      }),
    );

    await cmdFrame(
      { command: "frame", out: null, archive: true, bot_id: null },
      {
        fetchFn: async (url) => {
          if (String(url).endsWith("/frame.json")) {
            return Response.json({
              call_id: "bot-123",
              type: "webcam",
              participant: { id: "p1" },
              timestamp: { absolute: "2026-05-30T15:00:00Z" },
            });
          }
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          });
        },
      },
    );

    const archive = join(tmp, "bot-123_20260530T150000.000000Z_webcam_p1.png");
    expect(new Uint8Array(readFileSync(archive))).toEqual(new Uint8Array([1, 2, 3]));
    expect(existsSync(join(tmp, "latest.png"))).toBe(false);
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
  });

  it("exits when local WebSocket frame is not ready", async () => {
    writeFileSync(
      sf,
      JSON.stringify({
        local_frame_url: "http://127.0.0.1:18080/frame",
        frame_token: "secret-token",
      }),
    );

    await expect(
      cmdFrame(
        { command: "frame", out: join(tmp, "out.png"), bot_id: null },
        { fetchFn: async () => new Response("", { status: 404 }) },
      ),
    ).rejects.toBeInstanceOf(ExitError);
  });
});

describe("cmdFrame — with RTMP", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    process.env.SAMOAGENT_STATE_FILE = sf;
    process.env.RECALL_API_KEY = "fake-key";
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("runs ffmpeg when rtmp in state", async () => {
    const rtmpUrl = "rtmp://localhost:1935/live/call";
    writeFileSync(
      sf,
      JSON.stringify({ bot_id: "bot-rtmp", rtmp_local_url: rtmpUrl }),
    );
    const out = join(tmp, "frame.png");
    writeFileSync(out, "PNG");
    let capturedCmd: string[] = [];
    await cmdFrame(
      { command: "frame", out, bot_id: null },
      {
        run: (cmd) => {
          capturedCmd = cmd;
          return { returncode: 0, stderr: new Uint8Array() };
        },
      },
    );
    expect(capturedCmd.some((a) => a.includes("ffmpeg"))).toBe(true);
  });

  it("ffmpeg uses rtmp url as input", async () => {
    const rtmpUrl = "rtmp://localhost:1935/live/call";
    writeFileSync(sf, JSON.stringify({ rtmp_local_url: rtmpUrl }));
    const out = join(tmp, "frame.png");
    writeFileSync(out, "PNG");
    let capturedCmd: string[] = [];
    await cmdFrame(
      { command: "frame", out, bot_id: null },
      {
        run: (cmd) => {
          capturedCmd = cmd;
          return { returncode: 0, stderr: new Uint8Array() };
        },
      },
    );
    expect(capturedCmd).toContain(rtmpUrl);
  });

  it("ffmpeg output file in command", async () => {
    const rtmpUrl = "rtmp://localhost:1935/live/call";
    writeFileSync(sf, JSON.stringify({ rtmp_local_url: rtmpUrl }));
    const out = join(tmp, "myframe.png");
    writeFileSync(out, "PNG");
    let capturedCmd: string[] = [];
    await cmdFrame(
      { command: "frame", out, bot_id: null },
      {
        run: (cmd) => {
          capturedCmd = cmd;
          return { returncode: 0, stderr: new Uint8Array() };
        },
      },
    );
    expect(capturedCmd).toContain(out);
  });

  it("prints path on ffmpeg success", async () => {
    const rtmpUrl = "rtmp://localhost:1935/live/call";
    writeFileSync(sf, JSON.stringify({ rtmp_local_url: rtmpUrl }));
    const out = join(tmp, "frame.png");
    writeFileSync(out, "PNG");
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      await cmdFrame(
        { command: "frame", out, bot_id: null },
        { run: () => ({ returncode: 0, stderr: new Uint8Array() }) },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(writes.join("")).toContain(resolve(out));
  });

  it("exits on ffmpeg failure", async () => {
    const rtmpUrl = "rtmp://localhost:1935/live/call";
    writeFileSync(sf, JSON.stringify({ rtmp_local_url: rtmpUrl }));
    const out = join(tmp, "frame.png");
    // do NOT create the file — ffmpeg "failed"
    let code = -1;
    try {
      await cmdFrame(
        { command: "frame", out, bot_id: null },
        {
          run: () => ({
            returncode: 1,
            stderr: new TextEncoder().encode("Connection refused"),
          }),
        },
      );
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("remote rtmp url used directly", async () => {
    const remote = "rtmp://203.0.113.5:1935/live/call";
    writeFileSync(sf, JSON.stringify({ rtmp_local_url: remote }));
    const out = join(tmp, "frame.png");
    writeFileSync(out, "PNG");
    let capturedCmd: string[] = [];
    await cmdFrame(
      { command: "frame", out, bot_id: null },
      {
        run: (cmd) => {
          capturedCmd = cmd;
          return { returncode: 0, stderr: new Uint8Array() };
        },
      },
    );
    expect(capturedCmd).toContain(remote);
  });
});
