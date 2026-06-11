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
    process.env.SAMOGRAPH_STATE_FILE = sf;
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
      appendFileSync(tf, "[2026-05-28 10:00:00] SAMOGRAPH_CALL_ENDED\n");
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
        appendFileSync(tf, "[2026-05-28 10:00:10] SAMOGRAPH_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Alice: Hello everyone");
    expect(out).toContain("Bob: Hi there");
    expect(out).not.toContain("SAMOGRAPH_CALL_ENDED");
  });

  it("handles existing transcript with sentinel", async () => {
    writeFileSync(tf, "[2026-05-28 09:58:00] Alice: Earlier line\n");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    void (async () => {
      await sleep(80);
      appendFileSync(tf, "[2026-05-28 10:00:00] SAMOGRAPH_CALL_ENDED\n");
    })();
    await withTimeout(watch(FAST), 4000);
  });

  it("uses default transcript path when no state transcript_file", async () => {
    process.env.SAMOGRAPH_HOME = tmp;
    const dir = join(tmp, ".samograph");
    mkdirSync(dir, { recursive: true });
    const dtf = join(dir, "transcript.txt");
    writeFileSync(dtf, "");
    writeFileSync(sf, JSON.stringify({}));
    void (async () => {
      await sleep(80);
      appendFileSync(dtf, "[2026-05-28 10:00:00] SAMOGRAPH_CALL_ENDED\n");
    })();
    await withTimeout(watch(FAST), 4000);
  });

  it("exits immediately when sentinel already present", async () => {
    writeFileSync(
      tf,
      "[2026-05-28 10:00:00] Alice: hello\n" +
        "[2026-05-28 10:05:00] SAMOGRAPH_CALL_ENDED\n",
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
        appendFileSync(tf, "[2026-05-28 10:05:00] SAMOGRAPH_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Alice: hello");
    expect(out).not.toContain("SAMOGRAPH_CALL_ENDED");
  });

  it("participant saying phrase does not stop watch", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const out = await captureStdout(async () => {
      void (async () => {
        await sleep(80);
        appendFileSync(
          tf,
          "[2026-05-28 10:00:00] Bob: please run SAMOGRAPH_CALL_ENDED now\n",
        );
        await sleep(160);
        appendFileSync(tf, "[2026-05-28 10:05:00] SAMOGRAPH_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Bob: please run SAMOGRAPH_CALL_ENDED now");
  });

  // --- regression: partial line spanning two appends ---
  it("reassembles a partial line written across two appends", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const out = await captureStdout(async () => {
      void (async () => {
        await sleep(80);
        appendFileSync(tf, "[2026-05-28 10:00:01] Bob: hel");
        await sleep(120);
        appendFileSync(tf, "lo\n");
        await sleep(120);
        appendFileSync(tf, "[2026-05-28 10:00:10] SAMOGRAPH_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    // Exactly one occurrence, reassembled, not split.
    const matches = out.split("[2026-05-28 10:00:01] Bob: hello").length - 1;
    expect(matches).toBe(1);
    expect(out).not.toContain("Bob: hel\n");
  });

  // --- regression FIX 2: multibyte char split across read boundary ---
  it("does not corrupt a multibyte char split across two appends (é)", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const out = await captureStdout(async () => {
      void (async () => {
        await sleep(80);
        // 'é' is 0xC3 0xA9 in UTF-8. Split the single char across the boundary:
        // "Bob: " + 0xC3, then 0xA9 + "cole\n". Without a streaming decoder
        // this becomes U+FFFD.
        appendFileSync(
          tf,
          Buffer.from([0x5b, 0x5d, 0x20, 0x42, 0x6f, 0x62, 0x3a, 0x20, 0xc3]),
        ); // "[] Bob: " + 0xC3
        await sleep(120);
        appendFileSync(
          tf,
          Buffer.concat([Buffer.from([0xa9]), Buffer.from("cole\n", "utf-8")]),
        ); // 0xA9 completes 'é' + "cole\n"
        await sleep(120);
        appendFileSync(tf, "[2026-05-28 10:00:10] SAMOGRAPH_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Bob: école");
    expect(out).not.toContain("�");
  });

  it("does not corrupt a Cyrillic line split mid-character", async () => {
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const full = Buffer.from("[] Игорь: Привет мир\n", "utf-8");
    // Find a byte index that lands inside a multibyte char (after "[] ").
    const splitAt = 4; // mid 'И' (which starts at byte 3, 2 bytes wide)
    const out = await captureStdout(async () => {
      void (async () => {
        await sleep(80);
        appendFileSync(tf, full.subarray(0, splitAt));
        await sleep(120);
        appendFileSync(tf, full.subarray(splitAt));
        await sleep(120);
        appendFileSync(tf, "[2026-05-28 10:00:10] SAMOGRAPH_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 4000);
    });
    expect(out).toContain("Игорь: Привет мир");
    expect(out).not.toContain("�");
  });

  // --- regression FIX 1: truncation / re-sync ---
  it("re-syncs and emits lines after the file is truncated (re-join)", async () => {
    // Pre-existing content is intentionally LONGER than the fresh content so
    // that even if truncate+append collapse into one poll window, the observed
    // size is unambiguously smaller than the seeked position — guaranteeing the
    // shrink (size < pos) branch fires regardless of timing. State is present
    // the whole time so we only ever exit via the sentinel.
    const oldLine =
      "[2026-05-28 09:00:00] Alice: " + "old ".repeat(40) + "line\n";
    writeFileSync(tf, oldLine);
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));
    const out = await captureStdout(async () => {
      void (async () => {
        // Let watch seek to the end of the (long) pre-existing content first.
        await sleep(150);
        // A re-join clears the transcript in place (size shrinks to 0).
        writeFileSync(tf, "");
        await sleep(150);
        appendFileSync(tf, "[2026-05-28 10:00:00] Bob: fresh line\n");
        await sleep(120);
        appendFileSync(tf, "[2026-05-28 10:00:10] SAMOGRAPH_CALL_ENDED\n");
      })();
      await withTimeout(watch(FAST), 6000);
    });
    expect(out).toContain("Bob: fresh line");
    // Old content was already seeked past before truncation.
    expect(out).not.toContain("Alice: old");
  });
});
