import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  cmdJoin,
  spawnDetached,
  type JoinDeps,
  type SpawnChildFn,
  type SpawnedProc,
} from "../src/commands/join.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";
import { AVATAR_URL } from "../src/config.ts";
import { botName } from "../src/botName.ts";
import type { RecallClient } from "../src/recall.ts";
import type { ParsedArgs } from "../src/args.ts";

const WEBHOOK_BASE = "https://ngrok.example";
const WEBHOOK_PREFIX = `${WEBHOOK_BASE}/webhook?token=`;

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
    process.env.SAMOAGENT_STATE_FILE = sf;
    process.env.SAMOAGENT_HOME = tmp; // transcripts -> <tmp>/.samoagent/<timestamp>_transcript.txt
    process.env.SAMOAGENT_DICT_DIR = dictDir;
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
    expect(p.output_media.camera.config.url).toBe(AVATAR_URL);

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
    const deps: JoinDeps = {
      ...makeDeps(captured, { killed }),
      waitForNgrok: async () => null,
    };

    const { ExitError } = await import("../src/config.ts");
    await expect(cmdJoin(joinArgs(), deps)).rejects.toBeInstanceOf(ExitError);
    // server (4242) and ngrok (4243) must both be killed
    expect(killed).toContain(4242);
    expect(killed).toContain(4243);
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

    // Recall payload webhook endpoint also starts with the base
    const rc = captured.payload.recording_config;
    const webhookEp = rc.realtime_endpoints.find((e: any) =>
      e.events?.includes("transcript.data"),
    );
    expect(webhookEp.url).toStartWith("https://my-tunnel.example/webhook?token=");
  });

  it("--webhook-base with trailing slash: endpoint URL does not contain //webhook", async () => {
    const captured: { payload?: any } = {};
    await cmdJoin(joinArgs({ webhook_base: "https://my-tunnel.example/" }), makeDeps(captured));

    const state = JSON.parse(readFileSync(sf, "utf-8"));
    expect(state.webhook_url).not.toContain("//webhook");
    expect(state.webhook_url).toStartWith("https://my-tunnel.example/webhook?token=");
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

    const proc = spawnDetached(["ngrok", "http", "18080"], fakeSpawn);

    expect(proc.pid).toBe(1234);
    expect(calls).toEqual([
      {
        command: "ngrok",
        args: ["http", "18080"],
        options: { detached: true, stdio: "ignore" },
        unref: true,
        killedWith: [],
      },
    ]);

    proc.kill();
    expect(calls[0]!.killedWith).toEqual(["SIGTERM"]);
  });
});

export {};
