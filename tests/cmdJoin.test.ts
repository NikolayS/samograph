import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { cmdJoin, type JoinDeps, type SpawnedProc } from "../src/commands/join.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";
import { AVATAR_URL } from "../src/config.ts";
import { botName } from "../src/botName.ts";
import type { RecallClient } from "../src/recall.ts";
import type { ParsedArgs } from "../src/args.ts";

const WEBHOOK_BASE = "https://ngrok.example";
const WEBHOOK = `${WEBHOOK_BASE}/webhook`;

/** Fake recall client capturing the createBot payload. */
function makeFakeRecall(captured: { payload?: any }): RecallClient {
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
      return { id: "bot-new" };
    },
  };
}

function fakeProc(pid: number): SpawnedProc {
  return { pid, kill() {} };
}

/** Hermetic deps: no ngrok, no mediamtx, no child processes, no network. */
function makeDeps(captured: { payload?: any }): JoinDeps {
  let nextPid = 4242;
  return {
    recall: makeFakeRecall(captured),
    kill: () => {},
    spawn: () => fakeProc(nextPid++),
    waitForNgrok: async () => WEBHOOK_BASE,
    startMediamtx: async () => fakeProc(7000),
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
    process.env.SAMOAGENT_HOME = tmp; // transcript -> <tmp>/.samoagent/transcript.txt
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
    expect(webhookEp.url).toBe(WEBHOOK);
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
    expect(state.webhook_url).toBe(WEBHOOK);
    expect(typeof state.transcript_file).toBe("string");
    expect(state.transcript_file).toContain("transcript.txt");
    expect(typeof state.server_pid).toBe("number");
    expect(typeof state.ngrok_pid).toBe("number");
    // no rtmp without flags
    expect(state.rtmp_local_url).toBeUndefined();
  });

  it("transcript file is truncated on join", async () => {
    const captured: { payload?: any } = {};
    // First join creates the transcript file & state.
    await cmdJoin(joinArgs(), makeDeps(captured));
    const state = JSON.parse(readFileSync(sf, "utf-8"));
    const tf = state.transcript_file as string;
    writeFileSync(tf, "STALE CONTENT FROM A PREVIOUS CALL\n");
    // Re-join must clear it.
    await cmdJoin(joinArgs(), makeDeps(captured));
    expect(readFileSync(tf, "utf-8")).toBe("");
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
});

export {};
