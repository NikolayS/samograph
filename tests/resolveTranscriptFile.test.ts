import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  resolveNewTranscriptFile,
  resolveTranscriptFile,
} from "../src/transcript.ts";
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

  it("default path uses SAMOCALL_HOME", () => {
    process.env.SAMOCALL_HOME = tmp;
    const result = resolveTranscriptFile(null);
    expect(result).toBe(join(tmp, ".samocall", "transcript.txt"));
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

  it("default creates .samocall dir", () => {
    process.env.SAMOCALL_HOME = tmp;
    resolveTranscriptFile(null);
    expect(existsSync(join(tmp, ".samocall"))).toBe(true);
  });

  it("new transcript path starts with UTC timestamp prefix", () => {
    const custom = join(tmp, "calls");
    const result = resolveNewTranscriptFile(
      custom,
      new Date("2026-06-04T02:29:15Z"),
    );
    expect(result).toBe(join(custom, "20260604_022915_transcript.txt"));
    expect(existsSync(custom)).toBe(true);
  });

  it("new transcript path does not reuse an existing timestamped file", () => {
    const custom = join(tmp, "calls");
    const first = resolveNewTranscriptFile(
      custom,
      new Date("2026-06-04T02:29:15Z"),
    );
    writeFileSync(first, "previous call\n");

    const second = resolveNewTranscriptFile(
      custom,
      new Date("2026-06-04T02:29:15Z"),
    );

    expect(second).not.toBe(first);
    expect(basename(second)).toBe("20260604_022915_2_transcript.txt");
  });
});
