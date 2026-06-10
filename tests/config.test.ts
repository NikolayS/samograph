import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  RECALL_BASE,
  headers,
  stateFile,
  dictDir,
  defaultTranscriptFile,
} from "../src/config.ts";
import { saveEnv, restoreEnv } from "./helpers.ts";

describe("config constants", () => {
  it("RECALL_BASE matches reference", () => {
    expect(RECALL_BASE).toBe("https://us-east-1.recall.ai/api/v1");
  });
});

describe("headers", () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => {
    restoreEnv(env);
  });

  it("builds Authorization and Content-Type", () => {
    process.env.RECALL_API_KEY = "abc";
    expect(headers()).toEqual({
      Authorization: "Token abc",
      "Content-Type": "application/json",
    });
  });
});

describe("path overrides", () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => {
    restoreEnv(env);
  });

  it("stateFile honors SAMOCALL_STATE_FILE", () => {
    process.env.SAMOCALL_STATE_FILE = "/tmp/x/state.json";
    expect(stateFile()).toBe("/tmp/x/state.json");
  });

  it("stateFile default under home", () => {
    delete process.env.SAMOCALL_STATE_FILE;
    expect(stateFile()).toBe(join(homedir(), ".samocall", "state.json"));
  });

  it("dictDir honors SAMOCALL_DICT_DIR", () => {
    process.env.SAMOCALL_DICT_DIR = "/tmp/dicts";
    expect(dictDir()).toBe("/tmp/dicts");
  });

  it("defaultTranscriptFile honors SAMOCALL_HOME", () => {
    process.env.SAMOCALL_HOME = "/tmp/home";
    expect(defaultTranscriptFile()).toBe(
      join("/tmp/home", ".samocall", "transcript.txt"),
    );
  });
});
