import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdNotes } from "../src/commands/notes.ts";
import { cleanupTmpDir, makeTmpDir, restoreEnv, saveEnv } from "./helpers.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST = { pollMs: 20, stateGoneCheckEvery: 2, appearWaitMs: 5000 };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error("notes did not return in time")), ms),
    ),
  ]);
}

describe("cmdNotes", () => {
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

  it("appends live transcript lines to the configured Google Doc", async () => {
    const appended: Array<{ docId: string; text: string }> = [];
    process.env.GOOGLE_DOC_ID = "doc-123";
    writeFileSync(tf, "");
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));

    void (async () => {
      await sleep(80);
      appendFileSync(tf, "[2026-06-03 04:20:00] Alice: first note\n");
      await sleep(80);
      appendFileSync(tf, "[2026-06-03 04:20:10] Bob: second note\n");
      await sleep(80);
      appendFileSync(tf, "[2026-06-03 04:21:00] SAMOAGENT_CALL_ENDED\n");
    })();

    await withTimeout(
      cmdNotes(
        { command: "notes", doc_id: null },
        {
          docs: {
            appendText: async (docId, text) => {
              appended.push({ docId, text });
            },
          },
          watch: FAST,
        },
      ),
      4000,
    );

    expect(appended).toEqual([
      { docId: "doc-123", text: "[2026-06-03 04:20:00] Alice: first note\n" },
      { docId: "doc-123", text: "[2026-06-03 04:20:10] Bob: second note\n" },
    ]);
  });

  it("can replay existing transcript lines with --from-start", async () => {
    const texts: string[] = [];
    writeFileSync(
      tf,
      "[2026-06-03 04:20:00] Alice: existing\n",
    );
    writeFileSync(sf, JSON.stringify({ transcript_file: tf }));

    void (async () => {
      await sleep(80);
      appendFileSync(tf, "[2026-06-03 04:21:00] SAMOAGENT_CALL_ENDED\n");
    })();

    await withTimeout(
      cmdNotes(
        { command: "notes", doc_id: "doc-arg", from_start: true },
        {
          docs: {
            appendText: async (_docId, text) => {
              texts.push(text);
            },
          },
          watch: FAST,
        },
      ),
      4000,
    );

    expect(texts).toEqual(["[2026-06-03 04:20:00] Alice: existing\n"]);
  });
});
