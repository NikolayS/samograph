import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkTunnelHealth,
  cmdJoin,
  spawnDetached,
  waitForPresenceCamera,
  type JoinDeps,
  type SpawnChildFn,
  type SpawnedProc,
} from "../src/commands/join.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";
import { botName } from "../src/botName.ts";
import type { RecallClient } from "../src/recall.ts";
import type { ParsedArgs } from "../src/args.ts";

const WEBHOOK_BASE = "https://ngrok.example";
const WEBHOOK_PREFIX = `${WEBHOOK_BASE}/webhook?token=`;
const PRESENCE_PREFIX = `${WEBHOOK_BASE}/presence?token=`;

/** Fake recall client capturing the createBot payload. */
function makeFakeRecall(captured: { payload?: any; rejectCreateBot?: boolean }): RecallClient {
  return {
    async leaveCall() {
      return new Response("{}", { status: 200 });
    },
    async getBot() {
      return {};
    },
    async sendChat() {
      return new Response("{}", { status: 200 });
    },
    async outputAudio() { return new Response(); },
    async screenshot() {
      return new Response("{}", { status: 200 });
    },
    async createBot(payload: unknown) {
      captured.payload = payload;
      if (captured.rejectCreateBot) {
        throw new Error("recall failed");
      }
      return { id: "bot-new" };
    },
  };
}

function fakeProc(pid: number, killed?: number[]): SpawnedProc {
  return { pid, kill() { killed?.push(pid); } };
}

const PRESENCE_MARKER_PAGE = "<main class=\"samograph-presence\"></main>";

/** Healthy /health response: echoes the request nonce with the marker. */
function healthOkResponse(url: string): Response {
  const nonce = new URL(url).searchParams.get("nonce") ?? "";
  return Response.json({ ok: true, nonce, marker: "samograph-health" });
}

/** Default tunnel fake: /health round-trips succeed, /presence shows the page. */
function tunnelFetch(url: string): Response {
  if (url.includes("/health")) return healthOkResponse(url);
  return new Response(PRESENCE_MARKER_PAGE);
}

/** Hermetic deps: no ngrok, no mediamtx, no child processes, no network. */
function makeDeps(
  captured: { payload?: any; rejectCreateBot?: boolean },
  opts: { killed?: number[] } = {},
): JoinDeps {
  let nextPid = 4242;
  return {
    recall: makeFakeRecall(captured),
    kill: () => {},
    spawn: () => fakeProc(nextPid++, opts.killed),
    waitForNgrok: async () => WEBHOOK_BASE,
    startMediamtx: async () => fakeProc(7000, opts.killed),
    startNgrokTcpTunnel: async () => "tcp://ngrok.tcp:12345",
    fetch: async (url) => tunnelFetch(url),
    sleep: async () => {},
  };
}

/** Build a parsed-args object for join with sensible defaults. */
function joinArgs(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "join",
    url: "https://zoom.us/j/123",
    name: null,
    dict: null,
    port: 8080,
    transcript_dir: null,
    rtmp_url: null,
    rtmp: false,
    variant: null,
    ...over,
  } as ParsedArgs;
}

describe("cmdJoin payload + saved state", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;
  let dictDir: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    dictDir = join(tmp, "dicts");
    mkdirSync(dictDir, { recursive: true });
    process.env.SAMOGRAPH_STATE_FILE = sf;
    process.env.SAMOGRAPH_HOME = tmp; // transcripts -> <tmp>/.samograph/<timestamp>_transcript.txt
    process.env.SAMOGRAPH_DICT_DIR = dictDir;
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("no --dict: deepgram config (no keyterms), screenshot {}, webhook endpoint, no rtmp", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ name: "TARS" }), makeDeps(captured));

    const p = captured.payload;
    expect(p).toBeDefined();
    expect(p.bot_name).toBe(botName("TARS"));
    expect(p.output_media.camera.kind).toBe("webpage");
    expect(p.output_media.camera.config.url).toStartWith(PRESENCE_PREFIX);

    const rc = p.recording_config;
    expect(rc.transcript.provider.deepgram_streaming).toEqual({
      model: "nova-3",
      language: "multi",
      mip_opt_out: true,
    });
    expect(rc.transcript.provider.deepgram_streaming.keyterms).toBeUndefined();
    expect(rc.transcript.diarization.use_separate_streams_when_available).toBe(
      true,
    );
    expect(rc.screenshot).toEqual({});

    const webhookEp = rc.realtime_endpoints.find((e: any) =>
      Array.isArray(e.events) && e.events.includes("transcript.data"),
    );
    expect(webhookEp).toBeDefined();
    expect(webhookEp.url).toStartWith(WEBHOOK_PREFIX);
    expect(webhookEp.events).toEqual(["transcript.data"]);

    expect(rc.video_mixed_flv).toBeUndefined();
    const rtmpEp = rc.realtime_endpoints.find((e: any) =>
      Array.isArray(e.events) && e.events.includes("video_mixed_flv.data"),
    );
    expect(rtmpEp).toBeUndefined();
    expect(p.variant).toBeUndefined();
  });

  it("--variant adds recall bot variant for output media rendering", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ variant: "web_4_core" }), makeDeps(captured));

    expect(captured.payload.variant).toEqual({
      zoom: "web_4_core",
      google_meet: "web_4_core",
      microsoft_teams: "web_4_core",
    });

    const state = JSON.parse(readFileSync(sf, "utf8"));
    expect(state.variant).toBe("web_4_core");
  });

  it("--dict with an existing dict file adds keyterms", async () => {
    // loadDict keeps every non-empty trimmed line (blank lines dropped, no
    // comment syntax) and trims surrounding whitespace.
    writeFileSync(join(dictDir, "mydict.txt"), "Postgres\n  WAL  \n\nvacuum\n");
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ dict: "mydict" }), makeDeps(captured));

    const dg =
      captured.payload.recording_config.transcript.provider.deepgram_streaming;
    expect(dg.keyterms).toEqual(["Postgres", "WAL", "vacuum"]);
  });

  it("saved state.json reflects the new bot + paths", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ name: "TARS" }), makeDeps(captured));

    expect(existsSync(sf)).toBe(true);
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.bot_id).toBe("bot-new");
    expect(state.bot_name).toBe(botName("TARS"));
    expect(state.webhook_url).toStartWith(WEBHOOK_PREFIX);
    expect(state.presence_page_url).toStartWith(PRESENCE_PREFIX);
    expect(state.local_presence_url).toBeUndefined();
    expect(state.local_presence_update_url).toBe("http://127.0.0.1:8080/presence");
    expect(typeof state.presence_token).toBe("string");
    expect(typeof state.presence_write_token).toBe("string");
    expect(state.presence_write_token).not.toBe(state.presence_token);
    expect(state.presence_page_url).toContain(state.presence_token);
    expect(state.presence_page_url).not.toContain(state.presence_write_token);
    expect(captured.payload.output_media.camera.config.url).toBe(state.presence_page_url);
    expect(typeof state.transcript_file).toBe("string");
    expect(state.transcript_file).toContain("transcript.txt");
    expect(typeof state.server_pid).toBe("number");
    expect(typeof state.ngrok_pid).toBe("number");
    // no rtmp without flags
    expect(state.rtmp_local_url).toBeUndefined();
  });

  it("new join uses a fresh transcript file and preserves the previous one", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs(), makeDeps(captured));
    const firstState = JSON.parse(readFileSync(sf, "utf-8"));
    const firstTf = firstState.transcript_file as string;
    writeFileSync(firstTf, "PREVIOUS CALL TRANSCRIPT\n");

    await cmdJoin(joinArgs(), makeDeps(captured));
    const secondState = JSON.parse(readFileSync(sf, "utf-8"));
    const secondTf = secondState.transcript_file as string;

    expect(secondTf).not.toBe(firstTf);
    expect(readFileSync(firstTf, "utf-8")).toBe("PREVIOUS CALL TRANSCRIPT\n");
    expect(readFileSync(secondTf, "utf-8")).toBe("");
  });

  it("--rtmp-url remote: video_mixed_flv {} + rtmp endpoint + saved rtmp_local_url", async () => {
    const RTMP = "rtmp://1.2.3.4:1935/live/call";
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ rtmp_url: RTMP }), makeDeps(captured));

    const rc = captured.payload.recording_config;
    expect(rc.video_mixed_flv).toEqual({});

    const rtmpEp = rc.realtime_endpoints.find((e: any) =>
      Array.isArray(e.events) && e.events.includes("video_mixed_flv.data"),
    );
    expect(rtmpEp).toBeDefined();
    expect(rtmpEp.url).toBe(RTMP);
    expect(rtmpEp.events).toEqual(["video_mixed_flv.data"]);

    // transcript webhook still present
    const webhookEp = rc.realtime_endpoints.find((e: any) =>
      Array.isArray(e.events) && e.events.includes("transcript.data"),
    );
    expect(webhookEp).toBeDefined();

    // saved state carries the remote rtmp url (ffmpeg reads directly)
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.rtmp_local_url).toBe(RTMP);
  });

  it("--ws-video adds websocket video endpoint and safe frame state", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ ws_video: true, frame_dir: join(tmp, "frames") }), makeDeps(captured));

    const rc = captured.payload.recording_config;
    expect(rc.video_mixed_layout).toBe("gallery_view_v2");
    expect(rc.video_separate_png).toEqual({});
    const wsEp = rc.realtime_endpoints.find((e: any) =>
      Array.isArray(e.events) && e.events.includes("video_separate_png.data"),
    );
    expect(wsEp).toBeDefined();
    expect(wsEp.type).toBe("websocket");
    expect(wsEp.url).toStartWith("wss://ngrok.example/video-ws?token=");

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(wsEp.url).toContain(encodeURIComponent(state.frame_token));
    expect(state.ws_video_url).toBeUndefined();
    expect(state.local_frame_url).toBe("http://127.0.0.1:8080/frame");
    expect(state.local_frame_metadata_url).toBe("http://127.0.0.1:8080/frame.json");
    expect(typeof state.frame_token).toBe("string");
    expect(state.video_frame_dir).toBe(join(tmp, "frames"));
    expect(state.video_frame_file).toBe(join(tmp, "frames", "latest.png"));
    expect(existsSync(join(tmp, "frames"))).toBe(false);
  });

  it("passes _serve tokens via spawn env, never via argv", async () => {
    const captured: { payload?: any } = {};
    const spawnCalls: Array<{ cmd: string[]; env?: Record<string, string> }> = [];
    const deps: JoinDeps = {
      ...makeDeps(captured),
      spawn: (cmd, opts) => {
        spawnCalls.push({ cmd, env: opts?.env });
        return fakeProc(5000);
      },
    };

    await cmdJoin(joinArgs({ ws_video: true }), deps);

    const serveCall = spawnCalls.find((c) => c.cmd.includes("_serve"));
    expect(serveCall).toBeDefined();

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    const webhookToken = new URL(state.webhook_url).searchParams.get("token")!;
    const tokens = [
      webhookToken,
      state.frame_token,
      state.presence_token,
      state.presence_write_token,
    ];
    for (const token of tokens) {
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
      expect(serveCall!.cmd).not.toContain(token);
    }
    for (const flag of [
      "--webhook-token",
      "--frame-token",
      "--presence-token",
      "--presence-write-token",
    ]) {
      expect(serveCall!.cmd).not.toContain(flag);
    }
    expect(serveCall!.env).toMatchObject({
      SAMOGRAPH_WEBHOOK_TOKEN: webhookToken,
      SAMOGRAPH_FRAME_TOKEN: state.frame_token,
      SAMOGRAPH_PRESENCE_TOKEN: state.presence_token,
      SAMOGRAPH_PRESENCE_WRITE_TOKEN: state.presence_write_token,
    });
  });

  it("cleans up server and ngrok when recall createBot fails before state is saved", async () => {
    const killed: number[] = [];
    const captured: { payload?: any; rejectCreateBot?: boolean } = { rejectCreateBot: true };

    await expect(cmdJoin(joinArgs(), makeDeps(captured, { killed }))).rejects.toThrow(
      "recall failed",
    );

    expect(killed).toEqual([4242, 4243]);
    expect(existsSync(sf)).toBe(false);
  });

  it("cleans up server and ngrok when rtmp url parsing fails before state is saved", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};

    await expect(
      cmdJoin(joinArgs({ rtmp_url: "not a valid rtmp url" }), makeDeps(captured, { killed })),
    ).rejects.toThrow();

    expect(killed).toEqual([4242, 4243]);
    expect(existsSync(sf)).toBe(false);
  });

  it("waitForNgrok returns null — throws ExitError(1) and kills spawned processes", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const spawnCalls: string[][] = [];
    let nextPid = 4242;
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      spawn: (cmd) => {
        spawnCalls.push(cmd);
        return fakeProc(nextPid++, killed);
      },
      waitForNgrok: async () => null,
    };

    const { ExitError } = await import("../src/config.ts");
    await expect(cmdJoin(joinArgs(), deps)).rejects.toBeInstanceOf(ExitError);
    // ngrok (the only process spawned so far) must be killed; the webhook
    // server is only spawned once the public tunnel URL is known.
    expect(killed).toEqual([4242]);
    expect(spawnCalls.some((cmd) => cmd.includes("_serve"))).toBe(false);
    expect(existsSync(sf)).toBe(false);
  });

  it("--rtmp: mediamtx starts but ngrok TCP tunnel returns null — rtmp disabled, mediamtx killed", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const mediamtxPid = 9001;
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      startMediamtx: async () => fakeProc(mediamtxPid, killed),
      startNgrokTcpTunnel: async () => null,
    };

    await cmdJoin(joinArgs({ rtmp: true }), deps);

    // mediamtx must have been killed when TCP tunnel failed
    expect(killed).toContain(mediamtxPid);
    // no RTMP in saved state
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.rtmp_local_url).toBeUndefined();
    expect(state.mediamtx_pid).toBeUndefined();
  });

  it("--rtmp: mediamtx fails to start — join succeeds without RTMP", async () => {
    const captured: { payload?: any } = {};
    const deps: JoinDeps = {
      ...makeDeps(captured),
      startMediamtx: async () => null,
    };

    await cmdJoin(joinArgs({ rtmp: true }), deps);

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.rtmp_local_url).toBeUndefined();
    expect(state.mediamtx_pid).toBeUndefined();
    // still joined successfully
    expect(state.bot_id).toBe("bot-new");
  });

  it("--rtmp-url localhost: mediamtx started, rtmp_local_url set in state", async () => {
    const RTMP = "rtmp://localhost:1935/live/call";
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const mediamtxPid = 9002;
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      startMediamtx: async () => fakeProc(mediamtxPid, killed),
    };

    await cmdJoin(joinArgs({ rtmp_url: RTMP }), deps);

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.rtmp_local_url).toBe(RTMP);
    expect(state.mediamtx_pid).toBe(mediamtxPid);
    // rtmp realtime endpoint present
    const rc = captured.payload.recording_config;
    const rtmpEp = rc.realtime_endpoints.find((e: any) =>
      e.events?.includes("video_mixed_flv.data")
    );
    expect(rtmpEp).toBeDefined();
    expect(rc.video_mixed_flv).toEqual({});
  });

  it("--webhook-base: no ngrok spawned, webhook URL starts with provided base, ngrok_pid is null", async () => {
    const captured: { payload?: any } = {};
    const spawnedCmds: string[][] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured),
      spawn: (cmd) => {
        spawnedCmds.push(cmd);
        return fakeProc(5000);
      },
    };

    await cmdJoin(joinArgs({ webhook_base: "https://my-tunnel.example" }), deps);

    // ngrok must NOT have been spawned
    const ngrokSpawned = spawnedCmds.some((cmd) => cmd[0] === "ngrok");
    expect(ngrokSpawned).toBe(false);
    // only the server should have been spawned
    expect(spawnedCmds.length).toBe(1);

    // webhook URL should be rooted at the supplied base
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.webhook_url).toStartWith("https://my-tunnel.example/webhook?token=");
    expect(state.ngrok_pid).toBeNull();
    expect(state.presence_page_url).toStartWith("https://my-tunnel.example/presence?token=");

    // Recall payload webhook endpoint also starts with the base
    const rc = captured.payload.recording_config;
    const webhookEp = rc.realtime_endpoints.find((e: any) =>
      e.events?.includes("transcript.data"),
    );
    expect(rc.realtime_endpoints.length).toBeGreaterThan(0);
    expect(webhookEp).toBeDefined();
    expect(webhookEp.url).toStartWith("https://my-tunnel.example/webhook?token=");
    expect(captured.payload.output_media.camera.config.url).toStartWith(
      "https://my-tunnel.example/presence?token=",
    );
  });

  it("--webhook-base with trailing slash: endpoint URL does not contain //webhook", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ webhook_base: "https://my-tunnel.example/" }), makeDeps(captured));

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.webhook_url).not.toContain("//webhook");
    expect(state.webhook_url).toStartWith("https://my-tunnel.example/webhook?token=");

    const rc = captured.payload.recording_config;
    const webhookEndpoints = rc.realtime_endpoints.filter((e: any) =>
      e.events?.includes("transcript.data"),
    );
    expect(webhookEndpoints.length).toBeGreaterThan(0);
    expect(webhookEndpoints[0].url).toMatch(/^https:\/\/my-tunnel\.example\//);
    expect(webhookEndpoints[0].url).not.toContain("//webhook");
  });

  it("--webhook-base canonicalizes to origin before registering with Recall", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(
      joinArgs({ webhook_base: "https://user:pass@my-tunnel.example/some/path/" }),
      makeDeps(captured),
    );

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.webhook_url).toStartWith("https://my-tunnel.example/webhook?token=");
    expect(state.webhook_url).not.toContain("user:pass");

    const rc = captured.payload.recording_config;
    const webhookEndpoints = rc.realtime_endpoints.filter((e: any) =>
      e.events?.includes("transcript.data"),
    );
    expect(webhookEndpoints.length).toBeGreaterThan(0);
    expect(webhookEndpoints[0].url).toStartWith("https://my-tunnel.example/webhook?token=");
    expect(webhookEndpoints[0].url).not.toContain("user:pass");
  });

  it("--webhook-base rejects http URLs before spawning anything", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const spawnCalls: string[][] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      spawn: (cmd) => {
        spawnCalls.push(cmd);
        return fakeProc(4242, killed);
      },
    };
    const { ExitError } = await import("../src/config.ts");

    await expect(
      cmdJoin(joinArgs({ webhook_base: "http://insecure.example" }), deps),
    ).rejects.toBeInstanceOf(ExitError);

    // the base is validated before ngrok or the webhook server start
    expect(spawnCalls).toEqual([]);
    expect(killed).toEqual([]);
    expect(captured.payload).toBeUndefined();
    expect(existsSync(sf)).toBe(false);
  });

  it("unreachable presence camera page: warns and joins WITHOUT the camera", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      // tunnel relays fine (health round-trip ok), only the camera page 404s
      fetch: async (url) =>
        url.includes("/health")
          ? healthOkResponse(url)
          : new Response("Not Found", { status: 404 }),
    };

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    try {
      await cmdJoin(joinArgs(), deps);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    // join proceeded: bot created, state saved, nothing killed
    expect(killed).toEqual([]);
    expect(captured.payload).toBeDefined();
    expect(captured.payload.output_media).toBeUndefined();
    expect(existsSync(sf)).toBe(true);
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.bot_id).toBe("bot-new");
    expect(state.presence_page_url).toBeUndefined();
    expect(state.local_presence_update_url).toBeUndefined();
    expect(state.presence_token).toBeUndefined();
    expect(state.presence_write_token).toBeUndefined();

    const stderrOut = errWrites.join("");
    expect(stderrOut).toContain("Warning");
    expect(stderrOut).toContain("presence camera");
    expect(stderrOut).toContain("interstitial");
    expect(stderrOut).toContain("--no-presence");
  });

  it("tunnel interstitial page: warns and joins WITHOUT the camera", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      // health round-trip ok (server-to-server bypasses the interstitial);
      // the browser-UA camera preflight sees the interstitial page
      fetch: async (url) =>
        url.includes("/health")
          ? healthOkResponse(url)
          : new Response("<title>You are about to visit</title>"),
    };

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    try {
      await cmdJoin(joinArgs(), deps);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    expect(killed).toEqual([]);
    expect(captured.payload.output_media).toBeUndefined();
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.bot_id).toBe("bot-new");
    expect(state.presence_page_url).toBeUndefined();
    expect(errWrites.join("")).toContain("Warning");
  });

  it("--no-presence: skips preflight entirely and omits output_media, no warning", async () => {
    const captured: { payload?: any } = {};
    const fetchedUrls: string[] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured),
      fetch: async (url) => {
        fetchedUrls.push(url);
        return tunnelFetch(url);
      },
    };

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    try {
      await cmdJoin(joinArgs({ no_presence: true }), deps);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    // the tunnel health check may run, but the presence page is never probed
    expect(fetchedUrls.some((u) => u.includes("/presence"))).toBe(false);
    expect(captured.payload.output_media).toBeUndefined();
    expect(errWrites.join("")).toBe("");
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.bot_id).toBe("bot-new");
    expect(state.presence_page_url).toBeUndefined();
    expect(state.local_presence_update_url).toBeUndefined();
  });

  it("--presence-bg appends bg param to the presence page URL", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ presence_bg: "field" }), makeDeps(captured));

    const cameraUrl = captured.payload.output_media.camera.config.url as string;
    expect(cameraUrl).toStartWith(PRESENCE_PREFIX);
    expect(cameraUrl).toContain("&bg=field");
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.presence_page_url).toBe(cameraUrl);
  });

  it("no --presence-bg: presence page URL has no bg param", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs(), makeDeps(captured));
    expect(captured.payload.output_media.camera.config.url).not.toContain("bg=");
  });

  it("preflight success: presence camera config unchanged", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs(), makeDeps(captured));

    expect(captured.payload.output_media.camera.kind).toBe("webpage");
    expect(captured.payload.output_media.camera.config.url).toStartWith(PRESENCE_PREFIX);
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.presence_page_url).toStartWith(PRESENCE_PREFIX);
    expect(state.local_presence_update_url).toBe("http://127.0.0.1:8080/presence");
  });

  it("passes --public-base with the resolved tunnel URL to _serve (watchdog)", async () => {
    const captured: { payload?: any } = {};
    const spawnCalls: string[][] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured),
      spawn: (cmd) => {
        spawnCalls.push(cmd);
        return fakeProc(5000 + spawnCalls.length);
      },
    };

    await cmdJoin(joinArgs(), deps);

    const serveCall = spawnCalls.find((cmd) => cmd.includes("_serve"));
    expect(serveCall).toBeDefined();
    const i = serveCall!.indexOf("--public-base");
    expect(i).toBeGreaterThan(-1);
    expect(serveCall![i + 1]).toBe(WEBHOOK_BASE);
  });

  it("--webhook-base: _serve receives the normalized base as --public-base", async () => {
    const captured: { payload?: any } = {};
    const spawnCalls: string[][] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured),
      spawn: (cmd) => {
        spawnCalls.push(cmd);
        return fakeProc(5000 + spawnCalls.length);
      },
    };

    await cmdJoin(joinArgs({ webhook_base: "https://my-tunnel.example/some/path/" }), deps);

    const serveCall = spawnCalls.find((cmd) => cmd.includes("_serve"));
    expect(serveCall).toBeDefined();
    const i = serveCall!.indexOf("--public-base");
    expect(i).toBeGreaterThan(-1);
    expect(serveCall![i + 1]).toBe("https://my-tunnel.example");
  });

  it("--tunnel cloudflared: uses the cloudflared URL, no ngrok, records tunnel_pid", async () => {
    const captured: { payload?: any } = {};
    const spawnCalls: string[][] = [];
    const fetchedUrls: string[] = [];
    let cloudflaredPorts: number[] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured),
      spawn: (cmd) => {
        spawnCalls.push(cmd);
        return fakeProc(5000 + spawnCalls.length);
      },
      startCloudflared: async (port) => {
        cloudflaredPorts.push(port);
        return { proc: fakeProc(8888), url: "https://random-words.trycloudflare.com" };
      },
      fetch: async (url) => {
        fetchedUrls.push(url);
        return tunnelFetch(url);
      },
    };

    await cmdJoin(joinArgs({ tunnel: "cloudflared" }), deps);

    // cloudflared tunnel to the callback port; ngrok never spawned
    expect(cloudflaredPorts).toEqual([8080]);
    expect(spawnCalls.some((cmd) => cmd[0] === "ngrok")).toBe(false);

    // health round-trip ran against the cloudflared URL
    expect(
      fetchedUrls.some((u) =>
        u.startsWith("https://random-words.trycloudflare.com/health?nonce="),
      ),
    ).toBe(true);

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.webhook_url).toStartWith(
      "https://random-words.trycloudflare.com/webhook?token=",
    );
    expect(state.tunnel_pid).toBe(8888);
    expect(state.ngrok_pid).toBeNull();

    // _serve watchdog probes the cloudflared URL
    const serveCall = spawnCalls.find((cmd) => cmd.includes("_serve"));
    const i = serveCall!.indexOf("--public-base");
    expect(serveCall![i + 1]).toBe("https://random-words.trycloudflare.com");
  });

  it("--tunnel cloudflared: hard fail with actionable message when it cannot start", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      startCloudflared: async () => null,
    };

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    const { ExitError } = await import("../src/config.ts");
    try {
      await expect(
        cmdJoin(joinArgs({ tunnel: "cloudflared" }), deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    const stderrOut = errWrites.join("");
    expect(stderrOut).toContain("cloudflared");
    expect(stderrOut).toContain("CLOUDFLARED_BIN");
    expect(captured.payload).toBeUndefined();
    expect(existsSync(sf)).toBe(false);
  });

  it("--tunnel cloudflared: tunnel process is killed when join fails later", async () => {
    const killed: number[] = [];
    const captured: { payload?: any; rejectCreateBot?: boolean } = {
      rejectCreateBot: true,
    };
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      startCloudflared: async () => ({
        proc: fakeProc(8888, killed),
        url: "https://random-words.trycloudflare.com",
      }),
    };

    await expect(
      cmdJoin(joinArgs({ tunnel: "cloudflared" }), deps),
    ).rejects.toThrow("recall failed");

    expect(killed).toContain(8888);
    expect(existsSync(sf)).toBe(false);
  });

  it("runs a /health round-trip through the public URL before joining", async () => {
    const captured: { payload?: any } = {};
    const fetchedUrls: string[] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured),
      fetch: async (url) => {
        fetchedUrls.push(url);
        return tunnelFetch(url);
      },
    };

    await cmdJoin(joinArgs(), deps);

    expect(
      fetchedUrls.some((u) => u.startsWith(`${WEBHOOK_BASE}/health?nonce=`)),
    ).toBe(true);
    // health ok → join proceeded
    expect(captured.payload).toBeDefined();
    expect(existsSync(sf)).toBe(true);
  });

  it("ngrok-error-code on /health: hard fail naming the code, cleanup, no bot", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      fetch: async (url) =>
        url.includes("/health")
          ? new Response("ERR_NGROK_727: request limit exceeded", {
              status: 402,
              headers: { "ngrok-error-code": "ERR_NGROK_727" },
            })
          : new Response(PRESENCE_MARKER_PAGE),
    };

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    const { ExitError } = await import("../src/config.ts");
    try {
      await expect(cmdJoin(joinArgs(), deps)).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    const stderrOut = errWrites.join("");
    expect(stderrOut).toContain("ERR_NGROK_727");
    expect(stderrOut).toContain("--tunnel cloudflared");
    expect(stderrOut).toContain("--webhook-base");
    // no bot created, all spawned processes cleaned up, no state saved
    expect(captured.payload).toBeUndefined();
    expect(killed.length).toBeGreaterThan(0);
    expect(existsSync(sf)).toBe(false);
  });

  it("nonce mismatch on /health (interstitial-style body): generic hard fail", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      fetch: async () => new Response("<title>You are about to visit</title>"),
    };

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    const { ExitError } = await import("../src/config.ts");
    try {
      await expect(cmdJoin(joinArgs(), deps)).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    const stderrOut = errWrites.join("");
    // generic tunnel failure, not an ngrok error report
    expect(stderrOut).not.toContain("ERR_NGROK");
    expect(stderrOut).toContain("tunnel");
    expect(stderrOut).toContain("--tunnel cloudflared");
    expect(stderrOut).toContain("--webhook-base");
    expect(captured.payload).toBeUndefined();
    expect(killed.length).toBeGreaterThan(0);
    expect(existsSync(sf)).toBe(false);
  });

  it("--webhook-base path also runs the tunnel health check and refuses on failure", async () => {
    const killed: number[] = [];
    const captured: { payload?: any } = {};
    const fetchedUrls: string[] = [];
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      fetch: async (url) => {
        fetchedUrls.push(url);
        return new Response("Bad Gateway", { status: 502 });
      },
    };

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    const { ExitError } = await import("../src/config.ts");
    try {
      await expect(
        cmdJoin(joinArgs({ webhook_base: "https://my-tunnel.example" }), deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }

    expect(
      fetchedUrls.some((u) => u.startsWith("https://my-tunnel.example/health?nonce=")),
    ).toBe(true);
    expect(captured.payload).toBeUndefined();
    expect(existsSync(sf)).toBe(false);
  });
});

describe("checkTunnelHealth", () => {
  const BASE = "https://tunnel.example";

  it("succeeds on first matching nonce+marker response; never sleeps", async () => {
    const sleeps: number[] = [];
    const result = await checkTunnelHealth(
      BASE,
      async (url) => healthOkResponse(url),
      async (ms) => { sleeps.push(ms); },
    );
    expect(result.ok).toBe(true);
    expect(result.ngrokErrorCode).toBeNull();
    expect(sleeps).toEqual([]);
  });

  it("retries through fetch errors and succeeds once the tunnel is up", async () => {
    let calls = 0;
    const result = await checkTunnelHealth(
      BASE,
      async (url) => {
        calls += 1;
        if (calls <= 2) throw new Error("tunnel not up yet");
        return healthOkResponse(url);
      },
      async () => {},
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("fails fast with the code when the ngrok-error-code header is present", async () => {
    let calls = 0;
    const result = await checkTunnelHealth(
      BASE,
      async () => {
        calls += 1;
        return new Response("limit page", {
          status: 402,
          headers: { "ngrok-error-code": "ERR_NGROK_727" },
        });
      },
      async () => {},
    );
    expect(result.ok).toBe(false);
    expect(result.ngrokErrorCode).toBe("ERR_NGROK_727");
    // a tunnel-account error is definitive: no point burning the retry budget
    expect(calls).toBe(1);
  });

  it("extracts an ERR_NGROK code from an error body when the header is missing", async () => {
    const result = await checkTunnelHealth(
      BASE,
      async () =>
        new Response("ngrok gateway error: ERR_NGROK_3200 tunnel not found", {
          status: 404,
        }),
      async () => {},
      3,
    );
    expect(result.ok).toBe(false);
    expect(result.ngrokErrorCode).toBe("ERR_NGROK_3200");
  });

  it("fails generically when responses never echo the nonce", async () => {
    let calls = 0;
    const result = await checkTunnelHealth(
      BASE,
      async () => {
        calls += 1;
        return Response.json({ ok: true, nonce: "someone-elses", marker: "samograph-health" });
      },
      async () => {},
      4,
    );
    expect(result.ok).toBe(false);
    expect(result.ngrokErrorCode).toBeNull();
    expect(calls).toBe(4);
  });

  it("fails generically on interstitial HTML (non-JSON 200)", async () => {
    const result = await checkTunnelHealth(
      BASE,
      async () => new Response("<title>You are about to visit</title>"),
      async () => {},
      3,
    );
    expect(result.ok).toBe(false);
    expect(result.ngrokErrorCode).toBeNull();
  });
});

describe("waitForPresenceCamera", () => {
  const URL = "https://ngrok.example/presence?token=abc";
  const MARKER_PAGE = "<main class=\"samograph-presence\"></main>";

  it("returns true on a 200 with the marker on the first attempt; never sleeps", async () => {
    const sleeps: number[] = [];
    const result = await waitForPresenceCamera(
      URL,
      async () => new Response(MARKER_PAGE),
      async (ms) => { sleeps.push(ms); },
    );
    expect(result).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it("sends a browser-like Chrome User-Agent so UA-gated tunnel interstitials are visible", async () => {
    let capturedInit: RequestInit | undefined;
    const result = await waitForPresenceCamera(
      URL,
      async (_url, init) => {
        capturedInit = init;
        return new Response(MARKER_PAGE);
      },
      async () => {},
    );
    expect(result).toBe(true);
    const ua = (capturedInit?.headers as Record<string, string>)["User-Agent"];
    expect(ua).toContain("Mozilla/5.0");
    expect(ua).toContain("Chrome/");
  });

  it("retries through fetch errors and succeeds once the page comes up", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await waitForPresenceCamera(
      URL,
      async () => {
        calls += 1;
        if (calls <= 3) throw new Error("tunnel not up yet");
        return new Response(MARKER_PAGE);
      },
      async (ms) => { sleeps.push(ms); },
    );
    expect(result).toBe(true);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([750, 750, 750]);
  });

  it("returns false when every attempt throws", async () => {
    let calls = 0;
    const result = await waitForPresenceCamera(
      URL,
      async () => {
        calls += 1;
        throw new Error("connection refused");
      },
      async () => {},
    );
    expect(result).toBe(false);
    expect(calls).toBe(40);
  });

  it("returns false when responses are 200 but never contain the marker", async () => {
    let calls = 0;
    const result = await waitForPresenceCamera(
      URL,
      async () => {
        calls += 1;
        return new Response("<title>You are about to visit</title>");
      },
      async () => {},
    );
    expect(result).toBe(false);
    expect(calls).toBe(40);
  });
});

describe("spawnDetached", () => {
  it("spawns long-lived helpers as detached and unrefs them", () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: unknown;
      unref: boolean;
      killedWith: unknown[];
    }> = [];
    const fakeSpawn: SpawnChildFn = (command, args, options) => {
      const call = { command, args, options, unref: false, killedWith: [] as unknown[] };
      calls.push(call);
      return {
        pid: 1234,
        kill(signal?: NodeJS.Signals | number) {
          call.killedWith.push(signal);
          return true;
        },
        unref() {
          call.unref = true;
        },
      };
    };

    const proc = spawnDetached(["ngrok", "http", "18080"], {}, fakeSpawn);

    expect(proc.pid).toBe(1234);
    expect(calls).toEqual([
      {
        command: "ngrok",
        args: ["http", "18080"],
        options: { detached: true, stdio: "ignore", env: undefined },
        unref: true,
        killedWith: [],
      },
    ]);

    proc.kill();
    expect(calls[0]!.killedWith).toEqual(["SIGTERM"]);
  });
});

export {};
