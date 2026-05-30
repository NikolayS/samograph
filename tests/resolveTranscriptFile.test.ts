import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveTranscriptFile } from "../src/transcript.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

describe("resolveTranscriptFile", () => {
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

  it("default path uses SAMOAGENT_HOME", () => {
    process.env.SAMOAGENT_HOME = tmp;
    const result = resolveTranscriptFile(null);
    expect(result).toBe(join(tmp, ".samoagent", "transcript.txt"));
  });

  it("custom dir", () => {
    const custom = join(tmp, "mytranscripts");
    const result = resolveTranscriptFile(custom);
    expect(result).toBe(join(custom, "transcript.txt"));
    expect(existsSync(custom)).toBe(true);
  });

  it("creates parent dirs", () => {
    const nested = join(tmp, "a", "b", "c");
    resolveTranscriptFile(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("default creates .samoagent dir", () => {
    process.env.SAMOAGENT_HOME = tmp;
    resolveTranscriptFile(null);
    expect(existsSync(join(tmp, ".samoagent"))).toBe(true);
  });
});
