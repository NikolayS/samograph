import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AVATAR_URL, RECALL_BASE, ExitError } from "../config.ts";
import { resolveTranscriptFile } from "../transcript.ts";
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

export interface JoinDeps {
  recall?: RecallClient;
  kill?: (pid: number, signal: string) => void;
}

function defaultKill(pid: number, signal: string): void {
  try {
    process.kill(pid, signal as NodeJS.Signals);
  } catch {
    // ProcessLookupError equivalent — ignore
  }
}

export async function cmdJoin(
  args: ParsedArgs,
  deps: JoinDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const kill = deps.kill ?? defaultKill;

  const transcriptFile = resolveTranscriptFile(args.transcript_dir);
  writeFileSync(transcriptFile, ""); // clear for new session

  const keyterms = loadDict(args.dict);
  const name = botName(args.name);
  const port = args.port || 8080;
  let rtmpUrl = args.rtmp_url ?? null;
  const useRtmpAuto = args.rtmp ?? false;

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
  const server = Bun.spawn(
    [
      process.execPath,
      cliPath,
      "_serve",
      "--port",
      String(port),
      "--transcript-file",
      transcriptFile,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  // start ngrok
  const ngrok = Bun.spawn(["ngrok", "http", String(port), "--log=stdout"], {
    stdout: "ignore",
    stderr: "ignore",
  });

  process.stdout.write(`Starting ngrok tunnel on port ${port}...\n`);
  let webhookUrl = await waitForNgrok(port);
  if (!webhookUrl) {
    process.stderr.write(
      "Error: could not get ngrok URL. Is ngrok installed and authenticated?\n",
    );
    server.kill();
    ngrok.kill();
    throw new ExitError(1);
  }
  webhookUrl = webhookUrl.replace(/\/+$/, "") + "/webhook";
  process.stdout.write(`Webhook: ${webhookUrl}\n`);

  let mediamtxAuto: Bun.Subprocess | null = null;
  let rtmpViaNgrok = false;

  // --rtmp: auto-start mediamtx + open ngrok TCP tunnel → build RTMP URL automatically
  if (useRtmpAuto && !rtmpUrl) {
    process.stdout.write("Starting mediamtx RTMP server for --rtmp...\n");
    const mediamtxEarly = await startMediamtx();
    if (!mediamtxEarly) {
      process.stderr.write(
        "Warning: mediamtx failed to start — RTMP frame capture disabled.\n",
      );
    } else {
      process.stdout.write("Opening ngrok TCP tunnel to port 1935...\n");
      const tcpPublic = await startNgrokTcpTunnel(1935);
      if (tcpPublic === null) {
        process.stderr.write(
          "Warning: ngrok TCP tunnel failed — RTMP frame capture disabled.\n",
        );
        mediamtxEarly.kill();
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

  let mediamtxProc: Bun.Subprocess | null = null;
  let rtmpLocalUrl: string | null = null;

  if (rtmpUrl) {
    const rtmpHost = new URL(rtmpUrl).hostname || "";
    const rtmpIsLocal = rtmpHost === "localhost" || rtmpHost === "127.0.0.1";

    if (rtmpIsLocal) {
      process.stdout.write("Starting mediamtx RTMP server...\n");
      mediamtxProc = await startMediamtx();
      if (!mediamtxProc) {
        process.stderr.write(
          "Warning: mediamtx failed to start — RTMP frame capture disabled.\n",
        );
        rtmpUrl = null;
      } else {
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
    ngrok_pid: ngrok.pid,
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
  saveState(newState);

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
  process.stdout.write(`  python3 samoagent watch\n`);
  process.stdout.write(
    `Each line you receive is a new utterance: [timestamp] Speaker: text\n`,
  );
  process.stdout.write(
    `React to what is said. If someone addresses you or asks a question, respond in chat.\n`,
  );
  process.stdout.write(
    `To send a message in the meeting chat: python3 samoagent chat 'your message'\n`,
  );
  if (rtmpLocalUrl) {
    process.stdout.write(
      `To capture call frame:        python3 samoagent frame  (ffmpeg from RTMP stream)\n`,
    );
  } else {
    process.stdout.write(
      `To capture what's on screen:  python3 samoagent screenshot  (then Read screenshot.png)\n`,
    );
  }
  process.stdout.write(`To stop:                      python3 samoagent leave\n`);
  process.stdout.write(`--------------------------\n`);
}
