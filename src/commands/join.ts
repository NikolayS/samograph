import { writeFileSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RECALL_BASE, ExitError, stateFile } from "../config.ts";
import { resolveNewTranscriptFile } from "../transcript.ts";
import { resolveVideoFrameDir, resolveVideoFrameFile } from "../frameStore.ts";
import { loadDict } from "../dict.ts";
import { botName } from "../botName.ts";
import { loadState, saveState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";
import { postIntroOnJoin } from "./intro.ts";
import { DEFAULT_INTRO_TEXT } from "../introText.ts";
import { probeTunnelHealth, type TunnelProbeResult } from "../server.ts";
import { startCloudflared, type CloudflaredTunnel } from "../tunnel.ts";
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

export type PresenceFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Injectable seams for cmdJoin. All default to the real implementations so
 * production behavior is unchanged; tests override them to run hermetically
 * (no ngrok, no mediamtx, no child processes, no network).
 */
export interface JoinDeps {
  recall?: RecallClient;
  kill?: (pid: number, signal: string) => void;
  /** Spawn a detached process (webhook server / ngrok). */
  spawn?: (cmd: string[], opts?: SpawnOptions) => SpawnedProc;
  /** Poll ngrok's local API for the public webhook base URL. */
  waitForNgrok?: (port: number) => Promise<string | null>;
  /** Start a cloudflared quick tunnel to the local port (--tunnel cloudflared). */
  startCloudflared?: (port: number) => Promise<CloudflaredTunnel | null>;
  /** Start a local mediamtx RTMP server. */
  startMediamtx?: () => Promise<SpawnedProc | null>;
  /** Open a ngrok TCP tunnel to a local port; returns the public tcp:// URL. */
  startNgrokTcpTunnel?: (localPort: number) => Promise<string | null>;
  /** Fetch used for public camera-page preflight. */
  fetch?: PresenceFetch;
  /** Delay used between public camera-page preflight attempts. */
  sleep?: (ms: number) => Promise<void>;
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

/** Extra spawn options; env entries are merged over the parent environment. */
export interface SpawnOptions {
  env?: Record<string, string>;
}

export type SpawnChildFn = (
  command: string,
  args: string[],
  options: {
    detached: true;
    stdio: "ignore";
    env?: Record<string, string | undefined>;
  },
) => ChildProcLike;

export function spawnDetached(
  cmd: string[],
  opts: SpawnOptions = {},
  spawnFn: SpawnChildFn = spawnChild,
): SpawnedProc {
  const [command, ...args] = cmd;
  if (!command) {
    throw new Error("cannot spawn an empty command");
  }
  const proc = spawnFn(command, args, {
    detached: true,
    stdio: "ignore",
    // Pass secrets via env (merged over the parent env), never via argv,
    // so they stay out of `ps` output.
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
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

const PRESENCE_PAGE_MARKER = "samograph-presence";

/**
 * Tunnel round-trip health check. Unlike the presence-camera preflight below
 * (which merely degrades the camera), webhook reachability is core: a tunnel
 * that does not relay requests means the bot joins and sits silent with an
 * empty transcript — exactly the ERR_NGROK_727 failure mode. So join refuses.
 */
export type TunnelHealthResult = TunnelProbeResult;

// Same ~30 s budget as the presence preflight: fresh tunnel DNS
// (e.g. *.trycloudflare.com) can take 10–30 s to propagate.
const TUNNEL_HEALTH_ATTEMPTS = 40;
const TUNNEL_HEALTH_SLEEP_MS = 750;

const NGROK_ERROR_HINTS: Record<string, string> = {
  ERR_NGROK_727: "account HTTP request limit exceeded",
};

export async function checkTunnelHealth(
  publicBaseUrl: string,
  fetchFn: PresenceFetch = fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
  attempts = TUNNEL_HEALTH_ATTEMPTS,
  nonceFn: () => string = randomUUID,
): Promise<TunnelHealthResult> {
  for (let i = 0; i < attempts; i++) {
    const probe = await probeTunnelHealth(publicBaseUrl, fetchFn, nonceFn);
    if (probe.ok) {
      return probe;
    }
    // An ngrok error code (e.g. ERR_NGROK_727) is an account/tunnel-level
    // error and definitive — fail fast instead of burning the retry budget.
    if (probe.ngrokErrorCode) {
      return probe;
    }
    if (i < attempts - 1) {
      await sleepFn(TUNNEL_HEALTH_SLEEP_MS);
    }
  }
  return { ok: false, ngrokErrorCode: null };
}

export function tunnelHealthFailureMessage(result: TunnelHealthResult): string {
  const options =
    "Options: --tunnel cloudflared (free, no request limits), " +
    "--webhook-base with your own tunnel, or upgrade ngrok.";
  if (result.ngrokErrorCode) {
    const hint =
      NGROK_ERROR_HINTS[result.ngrokErrorCode] ??
      "see https://ngrok.com/docs/errors";
    return (
      `Error: tunnel is not relaying requests (ngrok error ${result.ngrokErrorCode}: ${hint}). ` +
      `The bot would join but receive no transcript. ${options}\n`
    );
  }
  return (
    "Error: tunnel is not relaying requests (the public /health round-trip never " +
    "returned this server's response — interstitial page, unreachable URL, or a " +
    "tunnel pointed at something else). " +
    `The bot would join but receive no transcript. ${options}\n`
  );
}

// Browser-like UA so the preflight sees what Recall's Chromium sees —
// ngrok-free/localtunnel serve their interstitials only to browser UAs.
const PRESENCE_PREFLIGHT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// ~30 s budget: fresh tunnel DNS (e.g. *.trycloudflare.com) can take 10–30 s.
const PRESENCE_PREFLIGHT_ATTEMPTS = 40;
const PRESENCE_PREFLIGHT_SLEEP_MS = 750;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPresenceCamera(
  url: string,
  fetchFn: PresenceFetch = fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
  attempts = PRESENCE_PREFLIGHT_ATTEMPTS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetchFn(url, {
        cache: "no-store",
        headers: { "User-Agent": PRESENCE_PREFLIGHT_USER_AGENT },
      });
      if (response.ok) {
        const text = await response.text();
        if (text.includes(PRESENCE_PAGE_MARKER)) {
          return true;
        }
      }
    } catch {
      // Tunnel/server may still be coming up.
    }
    if (i < attempts - 1) {
      await sleepFn(PRESENCE_PREFLIGHT_SLEEP_MS);
    }
  }
  return false;
}

export async function cmdJoin(
  args: ParsedArgs,
  deps: JoinDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const kill = deps.kill ?? defaultKill;
  const spawn = deps.spawn ?? spawnDetached;
  const waitForNgrokFn = deps.waitForNgrok ?? waitForNgrok;
  const startCloudflaredFn = deps.startCloudflared ?? startCloudflared;
  const startMediamtxFn = deps.startMediamtx ?? startMediamtx;
  const startNgrokTcpTunnelFn = deps.startNgrokTcpTunnel ?? startNgrokTcpTunnel;
  const fetchFn = deps.fetch ?? fetch;
  const sleepFn = deps.sleep ?? sleep;

  const transcriptFile = resolveNewTranscriptFile(args.transcript_dir);
  writeFileSync(transcriptFile, "", { flag: "wx", mode: 0o600 });
  const webhookToken = randomUUID();
  const frameToken = randomUUID();
  const presenceToken = randomUUID();
  const presenceWriteToken = randomUUID();

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
  for (const pidKey of ["server_pid", "ngrok_pid", "tunnel_pid", "mediamtx_pid"] as const) {
    const pid = oldState[pidKey];
    if (typeof pid === "number" && pid) {
      kill(pid, "SIGTERM");
    }
  }

  // cli entrypoint for the _serve subcommand (spawned once the public tunnel
  // URL is known, so it can be handed to the mid-call tunnel watchdog)
  const selfPath = fileURLToPath(import.meta.url);
  // resolve cli entrypoint: this module is src/commands/join.ts → cli is src/cli.ts
  const cliPath = selfPath.replace(/commands\/join\.ts$/, "cli.ts");
  const started = new Set<SpawnedProc>();
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
  const useCloudflared = (args.tunnel ?? "ngrok") === "cloudflared";
  const ngrok = webhookBase || useCloudflared
    ? null
    : spawn(["ngrok", "http", String(port), "--log=stdout"]);
  if (ngrok) started.add(ngrok);
  let cloudflared: SpawnedProc | null = null;

  try {
    let webhookUrl: string | null;
    if (webhookBase) {
      process.stdout.write(
        `Using external tunnel (--webhook-base): ${webhookBase} → localhost:${port}\n`,
      );
      webhookUrl = webhookBase;
    } else if (useCloudflared) {
      process.stdout.write(`Starting cloudflared tunnel on port ${port}...\n`);
      const tunnel = await startCloudflaredFn(port);
      if (!tunnel) {
        process.stderr.write(
          "Error: cloudflared tunnel failed to start. Install cloudflared " +
            "(e.g. brew install cloudflared) or point CLOUDFLARED_BIN at the " +
            "binary; alternatively use --webhook-base or the default ngrok tunnel.\n",
        );
        cleanupUnsaved();
        throw new ExitError(1);
      }
      cloudflared = tunnel.proc;
      started.add(cloudflared);
      webhookUrl = tunnel.url;
      process.stdout.write(`cloudflared tunnel: ${webhookUrl} → localhost:${port}\n`);
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
    const publicBaseUrl = webhookUrl.replace(/\/+$/, "");

    // Realtime-avatar persona id (not a secret): flag wins, else env. When set
    // it both selects bg=avatar by default and is forwarded to _serve below.
    const avatarPersonaId =
      args.anam_persona || process.env.SAMOGRAPH_ANAM_PERSONA_ID || "";
    const avatarVoiceId =
      args.anam_voice || process.env.SAMOGRAPH_ANAM_VOICE_ID || "";

    // start webhook server (spawns self with _serve subcommand). The public
    // base URL travels via argv (it is not a secret) so _serve can run the
    // mid-call tunnel watchdog; tokens travel via env only.
    const server = spawn(
      [
        process.execPath,
        cliPath,
        "_serve",
        "--port",
        String(port),
        "--transcript-file",
        transcriptFile,
        "--call-id-file",
        stateFile(),
        "--public-base",
        publicBaseUrl,
      ],
      {
        env: {
          SAMOGRAPH_WEBHOOK_TOKEN: webhookToken,
          SAMOGRAPH_FRAME_TOKEN: frameToken,
          SAMOGRAPH_PRESENCE_TOKEN: presenceToken,
          SAMOGRAPH_PRESENCE_WRITE_TOKEN: presenceWriteToken,
          // Persona id for the realtime avatar (not a secret). ANAM_API_KEY is
          // inherited from the parent env by spawnDetached, so the key stays out
          // of argv and out of this explicit map.
          ...(avatarPersonaId ? { SAMOGRAPH_ANAM_PERSONA_ID: avatarPersonaId } : {}),
          ...(avatarVoiceId ? { SAMOGRAPH_ANAM_VOICE_ID: avatarVoiceId } : {}),
        },
      },
    );
    started.add(server);

    // Escape hatch for restricted-egress environments (e.g. a sandbox whose
    // allowlist blocks *.trycloudflare.com): the LOCAL round-trip below is a
    // false negative there even though the meeting platform's bot, on its own
    // network, reaches the tunnel fine. Only set this when you have verified
    // the public URL is reachable by an external client out-of-band.
    const skipTunnelCheck = !!process.env.SAMOGRAPH_SKIP_TUNNEL_CHECK;

    // Round-trip check: does the public URL actually reach this server?
    // Unlike the presence preflight below (camera-only, degrades), webhook
    // reachability is core — a dead tunnel means join-and-sit-silent with an
    // empty transcript (the ERR_NGROK_727 incident), so refuse to join.
    if (skipTunnelCheck) {
      process.stdout.write(
        "Skipping tunnel health check (SAMOGRAPH_SKIP_TUNNEL_CHECK set) — " +
          "trusting a pre-verified external tunnel.\n",
      );
    } else {
      const health = await checkTunnelHealth(publicBaseUrl, fetchFn, sleepFn);
      if (!health.ok) {
        process.stderr.write(tunnelHealthFailureMessage(health));
        cleanupUnsaved();
        throw new ExitError(1);
      }
    }

    // null = join without the webpage presence camera (opted out via
    // --no-presence, or degraded after a failed preflight).
    // Explicit --presence-bg wins; otherwise default to the avatar look when a
    // persona is configured, so `--anam-persona <id>` alone is enough.
    const presenceBg = args.presence_bg ?? (avatarPersonaId ? "avatar" : null);
    const presenceBgSuffix = presenceBg
      ? `&bg=${encodeURIComponent(presenceBg)}`
      : "";
    let presencePageUrl: string | null = args.no_presence
      ? null
      : `${publicBaseUrl}/presence?token=${encodeURIComponent(presenceToken)}${presenceBgSuffix}`;
    webhookUrl = `${publicBaseUrl}/webhook?token=${encodeURIComponent(webhookToken)}`;
    process.stdout.write(`Webhook: ${webhookUrl}\n`);
    if (presencePageUrl) {
      process.stdout.write(`Presence camera: ${presencePageUrl}\n`);
      // Same false-negative rationale as the health check: the camera preflight
      // probes via this host's egress. When trusting a pre-verified tunnel,
      // skip it so the avatar camera is not needlessly dropped.
      const presenceReachable = skipTunnelCheck
        ? true
        : await waitForPresenceCamera(presencePageUrl, fetchFn, sleepFn);
      if (!presenceReachable) {
        process.stderr.write(
          "Warning: the presence camera page is not reachable by a browser — " +
            "likely a tunnel interstitial (free ngrok / localtunnel show one to browser " +
            "user agents). Joining WITHOUT the presence camera; transcription and chat " +
            "are unaffected, and `samograph presence` will be unavailable for this call. " +
            "Use a paid/clean tunnel for the camera, or pass --no-presence to skip this check.\n",
        );
        presencePageUrl = null;
      }
    }

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

  const payload: Record<string, unknown> = {
    meeting_url: args.url,
    bot_name: name,
    recording_config: recordingConfig,
  };
  if (presencePageUrl) {
    payload.output_media = {
      camera: {
        kind: "webpage",
        config: { url: presencePageUrl },
      },
    };
  }
  if (args.variant) {
    payload.variant = {
      zoom: args.variant,
      google_meet: args.variant,
      microsoft_teams: args.variant,
    };
  }

  const bot = (await recall.createBot(payload)) as { id: string };
  const bid = bot.id;

  const newState: Record<string, unknown> = {
    bot_id: bid,
    agent_name: args.name || "samograph",
    bot_name: name,
    webhook_url: webhookUrl,
    server_pid: server.pid,
    ngrok_pid: ngrok ? ngrok.pid : null,
    started_at: new Date().toISOString(),
    dict: args.dict ?? null,
    variant: args.variant ?? null,
    chime: args.chime ?? null,
    meeting_url: args.url,
    transcript_file: transcriptFile,
  };
  if (presencePageUrl) {
    // Presence state is saved only when the camera page is actually in use:
    // without it, `samograph presence` updates would have no visible effect,
    // so the command should report "no active dynamic presence server".
    newState.presence_page_url = presencePageUrl;
    newState.local_presence_update_url = `http://127.0.0.1:${port}/presence`;
    newState.presence_token = presenceToken;
    newState.presence_write_token = presenceWriteToken;
  }
  if (cloudflared) {
    // leave kills tunnel_pid the same way it kills ngrok_pid.
    newState.tunnel_pid = cloudflared.pid;
  }
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
  process.stdout.write(`  samograph watch\n`);
  process.stdout.write(
    `Each line you receive is a new utterance: [timestamp] Speaker: text\n`,
  );
  process.stdout.write(
    `React to what is said. If someone addresses you or asks a question, respond in chat.\n`,
  );
  process.stdout.write(
    `To send a message in the meeting chat: samograph chat 'your message'\n`,
  );
  if (presencePageUrl) {
    process.stdout.write(
      `To update bot presence:       samograph presence thinking 'short status'\n`,
    );
  }
  if (rtmpLocalUrl) {
    process.stdout.write(
      `To capture call frame:        samograph frame  (ffmpeg from RTMP stream)\n`,
    );
  } else if (useWsVideo) {
    process.stdout.write(
      `To list frame sources:       samograph frames\n`,
    );
    process.stdout.write(
      `To capture call frame:        samograph frame  (latest WebSocket PNG, written on demand)\n`,
    );
  } else {
    process.stdout.write(
      `To capture what's on screen:  samograph screenshot  (then Read screenshot.png)\n`,
    );
  }
  process.stdout.write(`To stop:                      samograph leave\n`);
  process.stdout.write(`--------------------------\n`);

  if (args.intro) {
    // Best-effort, non-fatal, fire-and-forget: poll the bot status in the
    // background and post a short self-introduction once it is admitted, so
    // `join` returns promptly and the agent can start `watch` without waiting
    // ~30s. Default text is English — at join time there is no transcript yet
    // to detect the call's language. postIntroOnJoin never throws.
    const introText =
      args.intro_text && args.intro_text.trim()
        ? args.intro_text.trim()
        : DEFAULT_INTRO_TEXT;
    void postIntroOnJoin(recall, bid, introText);
  }
  } catch (err) {
    cleanupUnsaved();
    throw err;
  }
}
