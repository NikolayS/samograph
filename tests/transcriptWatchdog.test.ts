import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startTranscriptWatchdog,
  transcriptStatusFromBot,
  type TranscriptWatchdogHandle,
} from "../src/server.ts";
import { SENTINEL_RE } from "../src/transcript.ts";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";

const WARNING_RE =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] SAMOGRAPH-WARNING: transcript stream failed/;

describe("startTranscriptWatchdog", () => {
  let tmp: string;
  let tf: string;
  let scheduled: Array<{ ms: number }>;
  let stderrOut: string[];

  beforeEach(() => {
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
    scheduled = [];
    stderrOut = [];
  });
  afterEach(() => {
    cleanupTmpDir(tmp);
  });

  function makeWatchdog(
    statusImpl: () => Promise<{ code: string | null; subCode: string | null } | null>,
  ): TranscriptWatchdogHandle {
    const handle = startTranscriptWatchdog({
      fetchStatus: statusImpl,
      transcriptPath: tf,
      stderr: (s) => {
        stderrOut.push(s);
      },
      schedule: (_fn, ms) => {
        scheduled.push({ ms });
        return { stop() {} };
      },
    });
    expect(handle).not.toBeNull();
    return handle!;
  }

  function transcriptLines(): string[] {
    return readFileSync(tf, "utf-8").split("\n").filter((l) => l);
  }

  it("returns null when no status fetcher is configured", () => {
    expect(
      startTranscriptWatchdog({ fetchStatus: null, transcriptPath: tf }),
    ).toBeNull();
    expect(
      startTranscriptWatchdog({ fetchStatus: undefined, transcriptPath: tf }),
    ).toBeNull();
  });

  it("schedules status probes every 20s by default", () => {
    makeWatchdog(async () => ({ code: "processing", subCode: null }));
    expect(scheduled).toEqual([{ ms: 20000 }]);
  });

  it("a healthy (processing/done) status writes nothing", async () => {
    const wd = makeWatchdog(async () => ({ code: "processing", subCode: null }));
    await wd.tick();
    await wd.tick();
    expect(transcriptLines()).toEqual([]);
    expect(stderrOut).toEqual([]);
  });

  it("warns once into the transcript when the stream fails, naming the sub_code", async () => {
    const wd = makeWatchdog(async () => ({
      code: "failed",
      subCode: "provider_connection_failed",
    }));

    await wd.tick();
    const lines = transcriptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(WARNING_RE);
    expect(lines[0]).toContain("provider_connection_failed");
    expect(lines[0]).toContain("no transcript");
    // must look like a transcript line so `watch` relays it, but must NOT be
    // the call-ended sentinel (watch would exit)
    expect(SENTINEL_RE.test(lines[0]!)).toBe(false);
    // mirrored to stderr
    expect(stderrOut.join("")).toContain(
      "SAMOGRAPH-WARNING: transcript stream failed",
    );

    // continued failures: warn once per outage, never spam
    await wd.tick();
    await wd.tick();
    expect(transcriptLines()).toHaveLength(1);
  });

  it("a transient status-fetch error is ignored (not a stream failure)", async () => {
    const wd = makeWatchdog(async () => {
      throw new Error("recall api blip");
    });
    await wd.tick();
    await wd.tick();
    expect(transcriptLines()).toEqual([]);
  });

  it("a null status (no recording yet) is ignored", async () => {
    const wd = makeWatchdog(async () => null);
    await wd.tick();
    expect(transcriptLines()).toEqual([]);
  });

  it("writes a single recovery line if the stream recovers", async () => {
    let code = "failed";
    const wd = makeWatchdog(async () => ({ code, subCode: "provider_connection_failed" }));

    await wd.tick(); // failure warning
    expect(transcriptLines()).toHaveLength(1);
    code = "processing";
    await wd.tick(); // recovery
    const lines = transcriptLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("SAMOGRAPH-WARNING: transcript stream recovered");

    // further successes do not repeat the recovery line
    await wd.tick();
    expect(transcriptLines()).toHaveLength(2);
  });
});

describe("transcriptStatusFromBot", () => {
  it("extracts code and sub_code from the first recording's transcript status", () => {
    const bot = {
      recordings: [
        {
          media_shortcuts: {
            transcript: {
              status: { code: "failed", sub_code: "provider_connection_failed" },
            },
          },
        },
      ],
    };
    expect(transcriptStatusFromBot(bot)).toEqual({
      code: "failed",
      subCode: "provider_connection_failed",
    });
  });

  it("returns subCode null when absent", () => {
    const bot = {
      recordings: [
        { media_shortcuts: { transcript: { status: { code: "processing" } } } },
      ],
    };
    expect(transcriptStatusFromBot(bot)).toEqual({
      code: "processing",
      subCode: null,
    });
  });

  it("returns null for missing/empty/malformed shapes", () => {
    expect(transcriptStatusFromBot(null)).toBeNull();
    expect(transcriptStatusFromBot({})).toBeNull();
    expect(transcriptStatusFromBot({ recordings: [] })).toBeNull();
    expect(transcriptStatusFromBot({ recordings: [{}] })).toBeNull();
    expect(
      transcriptStatusFromBot({ recordings: [{ media_shortcuts: {} }] }),
    ).toBeNull();
  });
});
