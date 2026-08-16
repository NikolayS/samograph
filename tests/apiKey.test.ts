import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiKey, ExitError } from "../src/config.ts";
import { saveEnv, restoreEnv, makeTmpDir, cleanupTmpDir } from "./helpers.ts";

describe("apiKey", () => {
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

  it("returns key when set via env var", () => {
    process.env.RECALL_API_KEY = "test-key-123";
    expect(apiKey()).toBe("test-key-123");
  });

  it("exits when not set and no config file", () => {
    delete process.env.RECALL_API_KEY;
    process.env.SAMOGRAPH_CONFIG_FILE = join(tmpDir, "config.json");
    let code = -1;
    try {
      apiKey();
    } catch (e) {
      expect(e).toBeInstanceOf(ExitError);
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("exits when empty string env var and no config file", () => {
    process.env.RECALL_API_KEY = "";
    process.env.SAMOGRAPH_CONFIG_FILE = join(tmpDir, "config.json");
    let code = -1;
    try {
      apiKey();
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("error message on missing key (throws ExitError)", () => {
    delete process.env.RECALL_API_KEY;
    process.env.SAMOGRAPH_CONFIG_FILE = join(tmpDir, "config.json");
    expect(() => apiKey()).toThrow(ExitError);
  });

  it("falls back to config file when env var is absent", () => {
    delete process.env.RECALL_API_KEY;
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ recall_api_key: "from-config-file" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = cfgPath;
    expect(apiKey()).toBe("from-config-file");
  });

  it("env var takes precedence over config file", () => {
    process.env.RECALL_API_KEY = "env-key";
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ recall_api_key: "config-key" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = cfgPath;
    expect(apiKey()).toBe("env-key");
  });

  it("returns config file key when env var is empty string", () => {
    process.env.RECALL_API_KEY = "";
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ recall_api_key: "config-fallback" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = cfgPath;
    expect(apiKey()).toBe("config-fallback");
  });

  it("exits when config file has empty recall_api_key", () => {
    delete process.env.RECALL_API_KEY;
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ recall_api_key: "" }), "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = cfgPath;
    expect(() => apiKey()).toThrow(ExitError);
  });

  it("exits when config file is malformed JSON", () => {
    delete process.env.RECALL_API_KEY;
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, "NOT JSON", "utf8");
    process.env.SAMOGRAPH_CONFIG_FILE = cfgPath;
    expect(() => apiKey()).toThrow(ExitError);
  });
});
