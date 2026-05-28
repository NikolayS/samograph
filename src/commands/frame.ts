import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ExitError } from "../config.ts";
import { loadState, botIdFromArgsOrState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";

export interface FrameDeps {
  recall?: RecallClient;
  /** Run ffmpeg-like command, returning exit code. */
  run?: (cmd: string[]) => { returncode: number; stderr: Uint8Array };
}

function defaultRun(cmd: string[]): { returncode: number; stderr: Uint8Array } {
  const proc = Bun.spawnSync(cmd, { timeout: 15000 });
  return { returncode: proc.exitCode, stderr: proc.stderr };
}

export async function cmdFrame(
  args: ParsedArgs,
  deps: FrameDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const run = deps.run ?? defaultRun;
  const out = args.out || "frame.png";

  const state = loadState();
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
  process.stderr.write("  4. After call ends: samoagent transcript\n");
  throw new ExitError(1);
}
