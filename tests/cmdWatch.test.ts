import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, appendFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { watch } from "../src/transcript.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fast poll options for tests.
const FAST = { pollMs: 20, stateGoneCheckEvery: 2, appearWaitMs: 5000 };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error("watch did not return in time")), ms),
    ),
  ]);
}

/** Capture stdout writes during fn. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (s: string | Uint8Array) => {
    writes.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout.write as unknown) = orig;
  }
  return writes.join("");
}

describe("cmdWatch", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;
  let tf: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    tf = join(tmp, "transcript.txt");
    process.env.SAMOAGENT_STATE_FILE = sf;
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("exits on call ended sentinel", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    void (async () => {
      await sleep(80);
      appendFileSync(tf, "[2026-05-28 10:00:00] SAMOAGENT_CALL_ENDED\n");
    })();
    await withTimeout(watch(FAST), 3000);
  });

  it("exits when state file disappears", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    void (async () => {
      await sleep(120);
      unlinkSync(sf);
    })();
    await withTimeout(watch(FAST), 4000);
  });

  it("prints lines before sentinel", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const out = await captureStdout(async () => {
      void (async () => {
        await sleep(80);
        appendFileSync(tf, "[2026-05-28 10:00:01] Alice: Hello everyone\n");
        appendFileSync(tf, "[2026-05-28 10:00:05] Bob: Hi there\n");
        appendFileSync(tf, "[2026-05-28 10:00:10] SAMOAGENT_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Alice: Hello everyone");
    expect(out).toContain("Bob: Hi there");
    expect(out).not.toContain("SAMOAGENT_CALL_ENDED");
  });

  it("handles existing transcript with sentinel", async () => {
    writeFileSync(tf, "[2026-05-28 09:58:00] Alice: Earlier line\n");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    void (async () => {
      await sleep(80);
      appendFileSync(tf, "[2026-05-28 10:00:00] SAMOAGENT_CALL_ENDED\n");
    })();
    await withTimeout(watch(FAST), 4000);
  });

  it("uses default transcript path when no state transcript_file", async () => {
    process.env.SAMOAGENT_HOME = tmp;
    const dir = join(tmp, ".samoagent");
    mkdirSync(dir, { recursive: true });
    const dtf = join(dir, "transcript.txt");
    writeFileSync(dtf, "");
    writeFileSync(sf, JSON.stringify({}));
    void (async () => {
      await sleep(80);
      appendFileSync(dtf, "[2026-05-28 10:00:00] SAMOAGENT_CALL_ENDED\n");
    })();
    await withTimeout(watch(FAST), 4000);
  });

  it("exits immediately when sentinel already present", async () => {
    writeFileSync(
      tf,
      "[2026-05-28 10:00:00] Alice: hello\n" +
        "[2026-05-28 10:05:00] SAMOAGENT_CALL_ENDED\n",
    );
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    // Must return without state.json being removed.
    await withTimeout(watch(FAST), 1500);
    expect(true).toBe(true);
  });

  it("sentinel not printed to stdout", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const out = await captureStdout(async () => {
      void (async () => {
        await sleep(80);
        appendFileSync(tf, "[2026-05-28 10:00:00] Alice: hello\n");
        await sleep(80);
        appendFileSync(tf, "[2026-05-28 10:05:00] SAMOAGENT_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Alice: hello");
    expect(out).not.toContain("SAMOAGENT_CALL_ENDED");
  });

  it("participant saying phrase does not stop watch", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const out = await captureStdout(async () => {
      void (async () => {
        await sleep(80);
        appendFileSync(
          tf,
          "[2026-05-28 10:00:00] Bob: please run SAMOAGENT_CALL_ENDED now\n",
        );
        await sleep(160);
        appendFileSync(tf, "[2026-05-28 10:05:00] SAMOAGENT_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Bob: please run SAMOAGENT_CALL_ENDED now");
  });
});
