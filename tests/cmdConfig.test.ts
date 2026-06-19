import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, writeConfig, configFile } from "../src/config.ts";
import { ExitError } from "../src/config.ts";
import { cmdConfig } from "../src/commands/config.ts";
import { saveEnv, restoreEnv, makeTmpDir, cleanupTmpDir } from "./helpers.ts";

describe("configFile", () => {
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => {
    restoreEnv(env);
  });

  it("honors SAMOGRAPH_CONFIG_FILE override", () => {
    process.env.SAMOGRAPH_CONFIG_FILE = "/tmp/test-config.json";
    expect(configFile()).toBe("/tmp/test-config.json");
  });

  it("defaults to ~/.samograph/config.json when no override", () => {
    delete process.env.SAMOGRAPH_CONFIG_FILE;
    expect(configFile()).toMatch(/\.samograph[/\\]config\.json$/);
  });
});

describe("readConfig", () => {
  let env: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(() => {
    env = saveEnv();
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmpDir);
  });

  it("returns {} when file does not exist", () => {
    process.env.SAMOGRAPH_CONFIG_FILE = join(tmpDir, "nonexistent.json");
    expect(readConfig()).toEqual({});
  });

  it("returns {} when file has malformed JSON", () => {
    const path = join(tmpDir, "config.json");
    writeFileSync(path, "NOT JSON", "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    expect(readConfig()).toEqual({});
  });

  it("returns {} when file contains a non-object", () => {
    const path = join(tmpDir, "config.json");
    writeFileSync(path, "42", "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    expect(readConfig()).toEqual({});
  });

  it("returns parsed config when file is valid", () => {
    const path = join(tmpDir, "config.json");
    writeFileSync(path, JSON.stringify({ recall_api_key: "tok" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    expect(readConfig()).toEqual({ recall_api_key: "tok" });
  });
});

describe("writeConfig", () => {
  let env: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(() => {
    env = saveEnv();
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmpDir);
  });

  it("creates the config file with the given key", () => {
    const path = join(tmpDir, "config.json");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    writeConfig("recall_api_key", "abc123");
    expect(readConfig()).toEqual({ recall_api_key: "abc123" });
  });

  it("merges into existing config without overwriting other keys", () => {
    const path = join(tmpDir, "config.json");
    writeFileSync(path, JSON.stringify({ other_key: "keep_me" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    writeConfig("recall_api_key", "new-key");
    const cfg = readConfig();
    expect(cfg.recall_api_key).toBe("new-key");
    expect((cfg as Record<string, string>)["other_key"]).toBe("keep_me");
  });

  it("creates parent directories when they don't exist", () => {
    const path = join(tmpDir, "nested", "deep", "config.json");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    writeConfig("recall_api_key", "tok");
    expect(readConfig()).toEqual({ recall_api_key: "tok" });
  });

  it("overwrites an existing key", () => {
    const path = join(tmpDir, "config.json");
    writeFileSync(path, JSON.stringify({ recall_api_key: "old" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    writeConfig("recall_api_key", "new");
    expect(readConfig()).toEqual({ recall_api_key: "new" });
  });
});

describe("cmdConfig set", () => {
  let env: Record<string, string | undefined>;
  let tmpDir: string;
  let stdoutBuf: string;
  let stderrBuf: string;
  let origStdout: typeof process.stdout.write;
  let origStderr: typeof process.stderr.write;

  beforeEach(() => {
    env = saveEnv();
    tmpDir = makeTmpDir();
    stdoutBuf = "";
    stderrBuf = "";
    origStdout = process.stdout.write.bind(process.stdout);
    origStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s: string | Uint8Array) => { stdoutBuf += String(s); return true; };
    process.stderr.write = (s: string | Uint8Array) => { stderrBuf += String(s); return true; };
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmpDir);
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  });

  it("stores recall-api-key in the config file", async () => {
    const path = join(tmpDir, "config.json");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    await cmdConfig({ command: "config", config_action: "set", config_key: "recall-api-key", config_value: "mytoken123" });
    expect(stdoutBuf).toContain("Saved recall-api-key");
    expect(readConfig()).toEqual({ recall_api_key: "mytoken123" });
  });

  it("rejects an unknown key", async () => {
    const path = join(tmpDir, "config.json");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    let code = -1;
    try {
      await cmdConfig({ command: "config", config_action: "set", config_key: "unknown-key", config_value: "val" });
    } catch (e) {
      expect(e).toBeInstanceOf(ExitError);
      code = (e as ExitError).code;
    }
    expect(code).toBe(2);
    expect(stderrBuf).toContain("unknown key");
  });

  it("exits when key or value is missing", async () => {
    const path = join(tmpDir, "config.json");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    let code = -1;
    try {
      await cmdConfig({ command: "config", config_action: "set", config_key: "recall-api-key" });
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(2);
  });
});

describe("cmdConfig get", () => {
  let env: Record<string, string | undefined>;
  let tmpDir: string;
  let stdoutBuf: string;
  let stderrBuf: string;
  let origStdout: typeof process.stdout.write;
  let origStderr: typeof process.stderr.write;

  beforeEach(() => {
    env = saveEnv();
    tmpDir = makeTmpDir();
    stdoutBuf = "";
    stderrBuf = "";
    origStdout = process.stdout.write.bind(process.stdout);
    origStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s: string | Uint8Array) => { stdoutBuf += String(s); return true; };
    process.stderr.write = (s: string | Uint8Array) => { stderrBuf += String(s); return true; };
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmpDir);
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  });

  it("prints the stored value", async () => {
    const path = join(tmpDir, "config.json");
    writeFileSync(path, JSON.stringify({ recall_api_key: "getme" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    await cmdConfig({ command: "config", config_action: "get", config_key: "recall-api-key" });
    expect(stdoutBuf.trim()).toBe("getme");
  });

  it("exits 1 when key is not set", async () => {
    const path = join(tmpDir, "config.json");
    writeFileSync(path, JSON.stringify({}), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    let code = -1;
    try {
      await cmdConfig({ command: "config", config_action: "get", config_key: "recall-api-key" });
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("exits 2 on unknown key", async () => {
    const path = join(tmpDir, "config.json");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    let code = -1;
    try {
      await cmdConfig({ command: "config", config_action: "get", config_key: "bad-key" });
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(2);
    expect(stderrBuf).toContain("unknown key");
  });
});

describe("cmdConfig help", () => {
  let env: Record<string, string | undefined>;
  let tmpDir: string;
  let stdoutBuf: string;
  let origStdout: typeof process.stdout.write;

  beforeEach(() => {
    env = saveEnv();
    tmpDir = makeTmpDir();
    stdoutBuf = "";
    origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => { stdoutBuf += String(s); return true; };
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmpDir);
    process.stdout.write = origStdout;
  });

  it("shows config file path and usage when called with no action", async () => {
    const path = join(tmpDir, "config.json");
    process.env.SAMOGRAPH_CONFIG_FILE = path;
    await cmdConfig({ command: "config", config_action: "help" });
    expect(stdoutBuf).toContain("Config file:");
    expect(stdoutBuf).toContain("recall-api-key");
  });
});

describe("config CLI integration", () => {
  const repoRoot = new URL("..", import.meta.url).pathname;

  it("config --help shows subcommand help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "config", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph config");
    expect(stdout).toContain("recall-api-key");
  });

  it("config command is listed in top-level help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("config");
  });
});
