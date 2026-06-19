import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdChimes } from "../src/commands/chimes.ts";
import { chimeNames, DEFAULT_CHIME } from "../src/chime.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (s: string) => { chunks.push(s); return true; };
  try { fn(); } finally { (process.stdout.write as unknown) = orig; }
  return chunks.join("");
}

describe("cmdChimes", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("lists every chime name", () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({}));
    const out = captureStdout(() => cmdChimes());
    for (const name of chimeNames()) {
      expect(out).toContain(name);
    }
  });

  it("marks the library default", () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({}));
    const out = captureStdout(() => cmdChimes());
    const line = out.split("\n").find((l) => l.startsWith(`${DEFAULT_CHIME} `) || l === DEFAULT_CHIME);
    expect(line).toBeDefined();
    expect(line!).toContain("default");
  });

  it("marks the active session chime when set at join", () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({ chime: "bell" }));
    const out = captureStdout(() => cmdChimes());
    const line = out.split("\n").find((l) => l.startsWith("bell"));
    expect(line!).toContain("session");
  });

  it("shows no session tag when no session chime is set", () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({ chime: null }));
    const out = captureStdout(() => cmdChimes());
    expect(out).not.toContain("session");
  });
});
