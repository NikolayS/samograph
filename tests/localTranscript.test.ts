import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { printLocalTranscript } from "../src/transcript.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

async function captureStdout(fn: () => void): Promise<string> {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (s: string) => {
    writes.push(s);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout.write as unknown) = orig;
  }
  return writes.join("");
}

describe("localTranscript", () => {
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

  it("filters sentinel", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(
      tf,
      "[2026-05-28 10:00:00] Alice: hello\n" +
        "[2026-05-28 10:05:00] SAMOCALL_CALL_ENDED\n",
    );
    writeFileSync(
      process.env.SAMOCALL_STATE_FILE!,
      JSON.stringify({ transcript_file: tf }),
    );
    const out = await captureStdout(() => printLocalTranscript());
    expect(out).toContain("Alice: hello");
    expect(out).not.toContain("SAMOCALL_CALL_ENDED");
  });

  it("empty transcript message", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
    writeFileSync(
      process.env.SAMOCALL_STATE_FILE!,
      JSON.stringify({ transcript_file: tf }),
    );
    const out = await captureStdout(() => printLocalTranscript());
    expect(out).toContain("is empty");
  });

  it("not found message", async () => {
    writeFileSync(
      process.env.SAMOCALL_STATE_FILE!,
      JSON.stringify({ transcript_file: join(tmp, "nope.txt") }),
    );
    const out = await captureStdout(() => printLocalTranscript());
    expect(out).toContain("Transcript not found");
  });
});
