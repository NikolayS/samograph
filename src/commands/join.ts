import { writeFileSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AVATAR_URL, RECALL_BASE, ExitError, stateFile } from "../config.ts";
import { resolveNewTranscriptFile } from "../transcript.ts";
import { resolveVideoFrameDir, resolveVideoFrameFile } from "../frameStore.ts";
import { loadDict } from "../dict.ts";
import { botName } from "../botName.ts";
import { loadState, saveState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";
import {
  rtmpStreamPath,
  waitForNgrok,
  startNgrokTcpTunnel,
  startMediamtx,
} from "../rtmp.ts";

/** Minimal handle for a spawned long-lived process (server / ngrok). */
export interface SpawnedProc {
  pid: number;
  kill(): void;
}

/**
 * Injectable seams for cmdJoin. All default to the real implementations so
 * production behavior is unchanged; tests override them to run hermetically
 * (no ngrok, no mediamtx, no child processes, no network).
 */
export interface JoinDeps {
  recall?: RecallClient;
  kill?: (pid: number, signal: string) => void;
  /** Spawn a detached process (webhook server / ngrok). */
  spawn?: (cmd: string[]) => SpawnedProc;
  /** Poll ngrok's local API for the public webhook base URL. */
  waitForNgrok?: (port: number) => Promise<string | null>;
  /** Start a local mediamtx RTMP server. */
  startMediamtx?: () => Promise<SpawnedProc | null>;
  /** Open a ngrok TCP tunnel to a local port; returns the public tcp:// URL. */
  startNgrokTcpTunnel?: (localPort: number) => Promise<string | null>;
}

function defaultKill(pid: number, signal: string): void {
  try {
    process.kill(pid, signal as NodeJS.Signals);
  } catch {
    // ProcessLookupError equivalent — ignore
  }
}

interface ChildProcLike {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

export type SpawnChildFn = (
  command: string,
  args: string[],
  options: {
    detached: true;
    stdio: "ignore";
  },
) => ChildProcLike;

export function spawnDetached(
  cmd: string[],
  spawnFn: SpawnChildFn = spawnChild,
): SpawnedProc {
  const [command, ...args] = cmd;
  if (!command) {
    throw new Error("cannot spawn an empty command");
  }
  const proc = spawnFn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  if (typeof proc.pid !== "number") {
    throw new Error(`failed to spawn ${command}`);
  }
  return {
    get pid() {
      return proc.pid!;
    },
    kill() {
      proc.kill("SIGTERM");
    },
  };
}

export async function cmdJoin(
  args: ParsedArgs,
  deps: JoinDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const kill = deps.kill ?? defaultKill;
  const spawn = deps.spawn ?? spawnDetached;
  const waitForNgrokFn = deps.waitForNgrok ?? waitForNgrok;
  const startMediamtxFn = deps.startMediamtx ?? startMediamtx;
  const startNgrokTcpTunnelFn = deps.startNgrokTcpTunnel ?? startNgrokTcpTunnel;

  const transcriptFile = resolveNewTranscriptFile(args.transcript_dir);
  writeFileSync(transcriptFile, "", { flag: "wx", mode: 0o600 });
  const webhookToken = randomUUID();
  const frameToken = randomUUID();

  const keyterms = loadDict(args.dict);
  const name = botName(args.name);
  const port = args.port || 8080;
  let rtmpUrl = args.rtmp_url ?? null;
  const useRtmpAuto = args.rtmp ?? false;
  const useWsVideo = args.ws_video ?? false;
  const videoFrameDir = resolveVideoFrameDir(args.frame_dir, false);
  const videoFrameFile = resolveVideoFrameFile(args.frame_dir, false);

  // kill any old processes
  const oldState = loadState();
  for (const pidKey of ["server_pid", "ngrok_pid", "mediamtx_pid"] as const) {
    const pid = oldState[pidKey];
    if (typeof pid === "number" && pid) {
      kill(pid, "SIGTERM");
    }
  }

  // start webhook server (spawns self with _serve subcommand)
  const selfPath = fileURLToPath(import.meta.url);
  // resolve cli entrypoint: this module is src/commands/join.ts → cli is src/cli.ts
  const cliPath = selfPath.replace(/commands\/join\.ts$/, "cli.ts");
  const server = spawn([
    process.execPath,
    cliPath,
    "_serve",
    "--port",
    String(port),
    "--transcript-file",
    transcriptFile,
    "--webhook-token",
    webhookToken,
    "--call-id-file",
    stateFile(),
    "--frame-token",
    frameToken,
  ]);
  const started = new Set<SpawnedProc>([server]);
  let stateSaved = false;

  const cleanupUnsaved = () => {
    if (stateSaved) return;
    for (const proc of started) {
      proc.kill();
    }
    started.clear();
  };

  // start ngrok — unless an external tunnel base URL was provided via --webhook-base
  const rejectWebhookBase = (message: string): never => {
    process.stderr.write(message);
    cleanupUnsaved();
    throw new ExitError(1);
  };
  const normalizeWebhookBase = (rawBase: string): string => {
    if (!rawBase) {
      rejectWebhookBase("Error: --webhook-base requires a non-empty https:// URL\n");
    }

    const parsedBase = (() => {
      try {
        return new URL(rawBase);
      } catch {
        return rejectWebhookBase(`Error: --webhook-base is not a valid URL: ${rawBase}\n`);
      }
    })();

    if (parsedBase.protocol !== "https:") {
      rejectWebhookBase("Error: --webhook-base must be an https:// URL\n");
    }

    return parsedBase.origin;
  };

  let webhookBase = args.webhook_base ?? null;
  if (webhookBase !== null) {
    webhookBase = normalizeWebhookBase(webhookBase);
  }
  const ngrok = webhookBase
    ? null
    : spawn(["ngrok", "http", String(port), "--log=stdout"]);
  if (ngrok) started.add(ngrok);

  try {
    let webhookUrl: string | null;
    if (webhookBase) {
      process.stdout.write(
        `Using external tunnel (--webhook-base): ${webhookBase} → localhost:${port}\n`,
      );
      webhookUrl = webhookBase;
    } else {
      process.stdout.write(`Starting ngrok tunnel on port ${port}...\n`);
      webhookUrl = await waitForNgrokFn(port);
    }
    if (!webhookUrl) {
      process.stderr.write(
        "Error: could not get ngrok URL. Is ngrok installed and authenticated?\n",
      );
      cleanupUnsaved();
      throw new ExitError(1);
    }
    webhookUrl = webhookUrl.replace(/\/+$/, "") + `/webhook?token=${encodeURIComponent(webhookToken)}`;
    process.stdout.write(`Webhook: ${webhookUrl}\n`);

    let mediamtxAuto: SpawnedProc | null = null;
    let rtmpViaNgrok = false;

  // --rtmp: auto-start mediamtx + open ngrok TCP tunnel → build RTMP URL automatically
  if (useRtmpAuto && !rtmpUrl) {
    process.stdout.write("Starting mediamtx RTMP server for --rtmp...\n");
    const mediamtxEarly = await startMediamtxFn();
    if (!mediamtxEarly) {
      process.stderr.write(
        "Warning: mediamtx failed to start — RTMP frame capture disabled.\n",
      );
    } else {
      process.stdout.write("Opening ngrok TCP tunnel to port 1935...\n");
      started.add(mediamtxEarly);
      const tcpPublic = await startNgrokTcpTunnelFn(1935);
      if (tcpPublic === null) {
        process.stderr.write(
          "Warning: ngrok TCP tunnel failed — RTMP frame capture disabled.\n",
        );
        mediamtxEarly.kill();
        started.delete(mediamtxEarly);
      } else {
        rtmpUrl = tcpPublic.replace("tcp://", "rtmp://") + "/live/call";
        process.stdout.write(`ngrok TCP tunnel: ${tcpPublic}\n`);
        process.stdout.write(`RTMP URL for recall.ai: ${rtmpUrl}\n`);
        mediamtxAuto = mediamtxEarly;
        rtmpViaNgrok = true;
      }
    }
  }

  process.stdout.write(`Joining: ${args.url}\n`);

  const deepgramConfig: Record<string, unknown> = {
    model: "nova-3",
    language: "multi",
    mip_opt_out: true,
  };
  if (keyterms.length) {
    deepgramConfig.keyterms = keyterms;
  }

  const realtimeEndpoints: Array<Record<string, unknown>> = [
    {
      type: "webhook",
      url: webhookUrl,
      events: ["transcript.data"],
    },
  ];

  let mediamtxProc: SpawnedProc | null = null;
  let rtmpLocalUrl: string | null = null;
  let wsVideoUrl: string | null = null;

  if (useWsVideo) {
    wsVideoUrl = webhookUrl
      .replace(/\/webhook(?:\?.*)?$/, "/video-ws")
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
    wsVideoUrl += `?token=${encodeURIComponent(frameToken)}`;
    realtimeEndpoints.push({
      type: "websocket",
      url: wsVideoUrl,
      events: ["video_separate_png.data"],
    });
    process.stdout.write(
      "WebSocket video: recall.ai → token-protected /video-ws → in-memory latest frame\n",
    );
  }

  if (rtmpUrl) {
    const rtmpHost = new URL(rtmpUrl).hostname || "";
    const rtmpIsLocal = rtmpHost === "localhost" || rtmpHost === "127.0.0.1";

    if (rtmpIsLocal) {
      process.stdout.write("Starting mediamtx RTMP server...\n");
      mediamtxProc = await startMediamtxFn();
      if (!mediamtxProc) {
        process.stderr.write(
          "Warning: mediamtx failed to start — RTMP frame capture disabled.\n",
        );
        rtmpUrl = null;
      } else {
        started.add(mediamtxProc);
        const streamPath = rtmpStreamPath(rtmpUrl);
        rtmpLocalUrl = `rtmp://localhost:1935/${streamPath}`;
        realtimeEndpoints.push({
          type: "rtmp",
          url: rtmpUrl,
          events: ["video_mixed_flv.data"],
        });
        process.stdout.write(
          `RTMP: recall.ai → ${rtmpUrl} → mediamtx (local) → ${rtmpLocalUrl}\n`,
        );
      }
    } else if (useRtmpAuto && rtmpViaNgrok) {
      mediamtxProc = mediamtxAuto;
      const streamPath = rtmpStreamPath(rtmpUrl);
      rtmpLocalUrl = `rtmp://localhost:1935/${streamPath}`;
      realtimeEndpoints.push({
        type: "rtmp",
        url: rtmpUrl,
        events: ["video_mixed_flv.data"],
      });
      process.stdout.write(
        `RTMP: recall.ai → ${rtmpUrl} (ngrok TCP) → mediamtx (local) → ${rtmpLocalUrl}\n`,
      );
    } else {
      rtmpLocalUrl = rtmpUrl;
      realtimeEndpoints.push({
        type: "rtmp",
        url: rtmpUrl,
        events: ["video_mixed_flv.data"],
      });
      process.stdout.write(
        `RTMP: recall.ai → ${rtmpUrl} (remote mediamtx; ffmpeg reads directly)\n`,
      );
    }
  }

  const recordingConfig: Record<string, unknown> = {
    transcript: {
      provider: { deepgram_streaming: deepgramConfig },
      diarization: { use_separate_streams_when_available: true },
    },
    screenshot: {},
    realtime_endpoints: realtimeEndpoints,
  };
  if (rtmpUrl) {
    recordingConfig.video_mixed_flv = {};
  }
  if (useWsVideo) {
    recordingConfig.video_mixed_layout = "gallery_view_v2";
    recordingConfig.video_separate_png = {};
  }

  const payload = {
    meeting_url: args.url,
    bot_name: name,
    output_media: {
      camera: {
        kind: "webpage",
        config: { url: AVATAR_URL },
      },
    },
    recording_config: recordingConfig,
  };

  const bot = (await recall.createBot(payload)) as { id: string };
  const bid = bot.id;

  const newState: Record<string, unknown> = {
    bot_id: bid,
    agent_name: args.name || "samoagent",
    bot_name: name,
    webhook_url: webhookUrl,
    server_pid: server.pid,
    ngrok_pid: ngrok ? ngrok.pid : null,
    started_at: new Date().toISOString(),
    dict: args.dict ?? null,
    meeting_url: args.url,
    transcript_file: transcriptFile,
  };
  if (mediamtxProc) {
    newState.mediamtx_pid = mediamtxProc.pid;
  }
  if (rtmpLocalUrl) {
    newState.rtmp_local_url = rtmpLocalUrl;
  }
  if (useWsVideo) {
    newState.local_frame_url = `http://127.0.0.1:${port}/frame`;
    newState.local_frame_metadata_url = `http://127.0.0.1:${port}/frame.json`;
    newState.frame_token = frameToken;
    newState.video_frame_dir = videoFrameDir;
    newState.video_frame_file = videoFrameFile;
  }
  saveState(newState);
  stateSaved = true;

  void RECALL_BASE; // referenced for parity; recall client owns the base URL

  process.stdout.write(`Bot ID:   ${bid}\n`);
  process.stdout.write(`Bot name: ${name}\n`);
  process.stdout.write(
    `Dict:     ${args.dict || "none"} (${keyterms.length} terms)\n`,
  );
  process.stdout.write(`Transcript -> ${transcriptFile}\n`);
  process.stdout.write(
    `\nThe agent will appear in the call within ~15 seconds.\n`,
  );
  process.stdout.write(`\n--- AGENT INSTRUCTIONS ---\n`);
  process.stdout.write(
    `IMPORTANT: You must now monitor the live transcript for the duration of the call.\n`,
  );
  process.stdout.write(`Run this command with your Monitor tool (persistent=true):\n`);
  process.stdout.write(`  samoagent watch\n`);
  process.stdout.write(
    `Each line you receive is a new utterance: [timestamp] Speaker: text\n`,
  );
  process.stdout.write(
    `React to what is said. If someone addresses you or asks a question, respond in chat.\n`,
  );
  process.stdout.write(
    `To send a message in the meeting chat: samoagent chat 'your message'\n`,
  );
  if (rtmpLocalUrl) {
    process.stdout.write(
      `To capture call frame:        samoagent frame  (ffmpeg from RTMP stream)\n`,
    );
  } else if (useWsVideo) {
    process.stdout.write(
      `To list frame sources:       samoagent frames\n`,
    );
    process.stdout.write(
      `To capture call frame:        samoagent frame  (latest WebSocket PNG, written on demand)\n`,
    );
  } else {
    process.stdout.write(
      `To capture what's on screen:  samoagent screenshot  (then Read screenshot.png)\n`,
    );
  }
  process.stdout.write(`To stop:                      samoagent leave\n`);
  process.stdout.write(`--------------------------\n`);
  } catch (err) {
    cleanupUnsaved();
    throw err;
  }
}
