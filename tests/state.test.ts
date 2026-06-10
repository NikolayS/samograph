import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitError } from "../src/config.ts";
import { loadState, saveState, botIdFromArgsOrState } from "../src/state.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

describe("loadState", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOCALL_STATE_FILE = join(tmp, "state.json");
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("returns empty dict when no file", () => {
    expect(loadState()).toEqual({});
  });

  it("returns parsed json when file exists", () => {
    writeFileSync(
      process.env.SAMOCALL_STATE_FILE!,
      JSON.stringify({ bot_id: "abc-123", server_pid: 9999 }),
    );
    expect(loadState()).toEqual({ bot_id: "abc-123", server_pid: 9999 });
  });

  it("preserves all fields", () => {
    const data = {
      bot_id: "xyz",
      agent_name: "TARS",
      webhook_url: "https://example.ngrok.io/webhook",
      server_pid: 1234,
      ngrok_pid: 5678,
      transcript_file: "/tmp/transcript.txt",
    };
    writeFileSync(process.env.SAMOCALL_STATE_FILE!, JSON.stringify(data));
    expect(loadState()).toEqual(data);
  });
});

describe("saveState", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("writes json file", () => {
    const sf = join(tmp, "sub", "state.json");
    process.env.SAMOCALL_STATE_FILE = sf;
    saveState({ bot_id: "test-bot" });
    expect(existsSync(sf)).toBe(true);
    expect(JSON.parse(readFileSync(sf, "utf-8"))).toEqual({
      bot_id: "test-bot",
    });
  });

  it("writes state directory and file owner-only", () => {
    const sf = join(tmp, "sub", "state.json");
    process.env.SAMOCALL_STATE_FILE = sf;
    saveState({ bot_id: "test-bot" });
    expect(statSync(join(tmp, "sub")).mode & 0o777).toBe(0o700);
    expect(statSync(sf).mode & 0o777).toBe(0o600);
  });

  it("does not chmod an existing explicit state directory", () => {
    const dir = join(tmp, "explicit");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const sf = join(dir, "state.json");
    process.env.SAMOCALL_STATE_FILE = sf;
    saveState({ bot_id: "test-bot" });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(sf).mode & 0o777).toBe(0o600);
  });

  it("creates parent dirs", () => {
    const sf = join(tmp, "a", "b", "state.json");
    process.env.SAMOCALL_STATE_FILE = sf;
    saveState({ x: 1 });
    expect(existsSync(sf)).toBe(true);
  });

  it("round trip", () => {
    const sf = join(tmp, "state.json");
    process.env.SAMOCALL_STATE_FILE = sf;
    const original = { bot_id: "rt-1", server_pid: 42, nested: { key: "val" } };
    saveState(original);
    expect(loadState()).toEqual(original);
  });

  it("overwrites existing", () => {
    const sf = join(tmp, "state.json");
    process.env.SAMOCALL_STATE_FILE = sf;
    writeFileSync(sf, JSON.stringify({ bot_id: "old" }));
    saveState({ bot_id: "new" });
    expect(loadState().bot_id).toBe("new");
  });
});

describe("botIdFromArgsOrState", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOCALL_STATE_FILE = join(tmp, "state.json");
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("returns explicit bot id", () => {
    writeFileSync(
      process.env.SAMOCALL_STATE_FILE!,
      JSON.stringify({ bot_id: "state-bot" }),
    );
    expect(botIdFromArgsOrState("explicit-bot")).toBe("explicit-bot");
  });

  it("returns state bot id when no arg", () => {
    writeFileSync(
      process.env.SAMOCALL_STATE_FILE!,
      JSON.stringify({ bot_id: "state-bot-123" }),
    );
    expect(botIdFromArgsOrState(null)).toBe("state-bot-123");
  });

  it("exits when no arg and no state", () => {
    expect(() => botIdFromArgsOrState(null)).toThrow(ExitError);
  });

  it("exits when no arg and state missing bot_id", () => {
    writeFileSync(
      process.env.SAMOCALL_STATE_FILE!,
      JSON.stringify({ server_pid: 123 }),
    );
    let code = 0;
    try {
      botIdFromArgsOrState(null);
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });
});
