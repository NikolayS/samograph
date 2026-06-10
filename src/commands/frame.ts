import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ExitError } from "../config.ts";
import { loadState, botIdFromArgsOrState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";
import {
  archiveExistingFrame,
  archiveFrameBytes,
  frameMetadataPath,
  normalizeFrameSource,
  resolveFrameOutput,
  writeFrameFiles,
  type VideoFrameMetadata,
} from "../frameStore.ts";

export interface FrameDeps {
  recall?: RecallClient;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Run ffmpeg-like command, returning exit code. */
  run?: (cmd: string[]) => { returncode: number; stderr: Uint8Array };
}

function defaultRun(cmd: string[]): { returncode: number; stderr: Uint8Array } {
  const proc = Bun.spawnSync(cmd, { timeout: 15000 });
  return { returncode: proc.exitCode, stderr: proc.stderr };
}

function withFrameSource(url: string, source?: string | null): string {
  const key = normalizeFrameSource(source);
  if (!key) return url;
  const u = new URL(url);
  u.searchParams.set("source", source!);
  return u.toString();
}

export async function cmdFrame(
  args: ParsedArgs,
  deps: FrameDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const fetchFn = deps.fetchFn ?? fetch;
  const run = deps.run ?? defaultRun;

  const state = loadState();
  const archive = args.archive ?? false;
  const out = resolveFrameOutput(args.out, state);
  const rtmpLocalUrl = state.rtmp_local_url;

  // If RTMP stream is configured, grab a frame with ffmpeg.
  if (typeof rtmpLocalUrl === "string" && rtmpLocalUrl) {
    let ffmpeg = "/opt/homebrew/bin/ffmpeg";
    if (!existsSync(ffmpeg)) {
      ffmpeg = "ffmpeg";
    }
    const cmd = [
      ffmpeg,
      "-y",
      "-i",
      rtmpLocalUrl,
      "-vframes",
      "1",
      "-update",
      "1",
      "-q:v",
      "2",
      out,
    ];
    const result = run(cmd);
    if (result.returncode === 0 && existsSync(out)) {
      process.stdout.write(resolve(out) + "\n");
      return;
    }
    process.stderr.write(
      `FRAME_ERROR: ffmpeg failed to grab frame from ${rtmpLocalUrl}\n`,
    );
    const errText = Buffer.from(result.stderr).toString("utf-8");
    process.stderr.write(errText.slice(-500) + "\n");
    throw new ExitError(1);
  }

  const localFrameUrl = state.local_frame_url;
  if (typeof localFrameUrl === "string" && localFrameUrl) {
    const headers: Record<string, string> = {};
    if (typeof state.frame_token === "string" && state.frame_token) {
      headers["X-Samocall-Frame-Token"] = state.frame_token;
    }
    let resp: Response;
    try {
      resp = await fetchFn(withFrameSource(localFrameUrl, args.frame_source), { headers });
    } catch (e) {
      process.stderr.write(
        `FRAME_UNAVAILABLE: local WebSocket frame server is not reachable: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      throw new ExitError(1);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    if (resp.status === 200 && contentType.startsWith("image/")) {
      let metadata: VideoFrameMetadata = {};
      const metadataUrl = state.local_frame_metadata_url;
      if (typeof metadataUrl === "string" && metadataUrl) {
        try {
          const metaResp = await fetchFn(withFrameSource(metadataUrl, args.frame_source), { headers });
          if (metaResp.status === 200) {
            metadata = (await metaResp.json()) as VideoFrameMetadata;
          }
        } catch {
          metadata = {};
        }
      }
      const raw = new Uint8Array(await resp.arrayBuffer());
      // Always write latest.png (or explicit --out); --archive additionally creates a timestamped copy.
      writeFrameFiles(out, raw, metadata);
      const output = archive && !args.out
        ? archiveFrameBytes(String(state.video_frame_dir ?? dirname(out)), raw, metadata)
        : out;
      process.stdout.write(resolve(output) + "\n");
      return;
    }
    process.stderr.write("FRAME_UNAVAILABLE: no WebSocket video frame received yet.\n");
    process.stderr.write("Wait for Recall to deliver video_separate_png.data, then retry.\n");
    throw new ExitError(1);
  }

  const legacyFrameFile = state.video_frame_file;
  if (typeof legacyFrameFile === "string" && legacyFrameFile && existsSync(legacyFrameFile)) {
    const output = archive && !args.out ? archiveExistingFrame(legacyFrameFile) : out;
    if (!(archive && !args.out)) {
      writeFileSync(output, readFileSync(legacyFrameFile));
      const metadataFile = frameMetadataPath(legacyFrameFile);
      if (existsSync(metadataFile)) {
        writeFileSync(frameMetadataPath(output), readFileSync(metadataFile));
      }
    }
    process.stdout.write(resolve(output) + "\n");
    return;
  }

  // Try recall.ai screenshot endpoint.
  const bid = botIdFromArgsOrState(args.bot_id);
  const resp = await recall.screenshot(bid);
  const contentType = resp.headers.get("content-type") ?? "";
  if (resp.status === 200 && contentType.startsWith("image/")) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    writeFileSync(out, buf);
    process.stdout.write(resolve(out) + "\n");
    return;
  }

  // Not available — tell the agent how to proceed.
  const meetingUrl = (state.meeting_url as string) ?? "";
  process.stderr.write(
    "FRAME_UNAVAILABLE: no RTMP stream configured and recall.ai live frame not available.\n",
  );
  process.stderr.write("Options:\n");
  process.stderr.write(
    "  1. Rejoin with --rtmp to enable RTMP frames via ngrok TCP (no VM needed; requires ngrok card on file)\n",
  );
  process.stderr.write(
    "  2. Rejoin with --rtmp-url rtmp://PUBLIC_IP:1935/live/call to enable RTMP frames via cloud VM\n",
  );
  process.stderr.write(`  3. Use browser tools to screenshot: ${meetingUrl}\n`);
  process.stderr.write("  4. After call ends: samocall transcript\n");
  throw new ExitError(1);
}
