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
    process.env.SAMOCALL_STATE_FILE = sf;
  });

  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  function fakeDocs(writes: Array<{ method: string; docId: string; heading?: string; text: string }>) {
    return {
      appendText: async (docId: string, text: string) => {
        writes.push({ method: "appendText", docId, text });
      },
      appendToSection: async (docId: string, heading: string, text: string) => {
        writes.push({ method: "appendToSection", docId, heading, text });
      },
    };
  }

  it("initializes a GitLab-style live meeting doc template", async () => {
    const writes: Array<{ method: string; docId: string; heading?: string; text: string }> = [];
    await cmdNotes(
      { command: "notes", notes_action: "init", doc_id: "doc-arg", title: "Customer call" },
      { docs: fakeDocs(writes) },
    );
    expect(writes[0]!.method).toBe("appendText");
    expect(writes[0]!.docId).toBe("doc-arg");
    expect(writes[0]!.text).toContain("Customer call");
    expect(writes[0]!.text).toContain("Agenda / questions");
    expect(writes[0]!.text).toContain("Decisions");
    expect(writes[0]!.text).toContain("Next steps / action items");
  });

  it("adds deliberate points, decisions, and action items to sections", async () => {
    const writes: Array<{ method: string; docId: string; heading?: string; text: string }> = [];
    const docs = fakeDocs(writes);
    await cmdNotes(
      {
        command: "notes",
        notes_action: "point",
        doc_id: "doc-arg",
        section: "important",
        speaker: "Alice",
        message: "Migration risk is the blocker",
      },
      { docs },
    );
    await cmdNotes(
      {
        command: "notes",
        notes_action: "decision",
        doc_id: "doc-arg",
        message: "Use logical replication for phase 1",
      },
      { docs },
    );
    await cmdNotes(
      {
        command: "notes",
        notes_action: "action",
        doc_id: "doc-arg",
        owner: "Nik",
        due: "2026-06-07",
        message: "Open migration checklist issue",
      },
      { docs },
    );

    expect(writes).toEqual([
      {
        method: "appendToSection",
        docId: "doc-arg",
        heading: "Important points",
        text: "1. Alice: Migration risk is the blocker\n",
      },
      {
        method: "appendToSection",
        docId: "doc-arg",
        heading: "Decisions",
        text: "1. Use logical replication for phase 1\n",
      },
      {
        method: "appendToSection",
        docId: "doc-arg",
        heading: "Next steps / action items",
        text: "1. Owner: Nik. Due: 2026-06-07. Open migration checklist issue\n",
      },
    ]);
  });

  it("appends live transcript lines only in explicit transcript mode", async () => {
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
      appendFileSync(tf, "[2026-06-03 04:21:00] SAMOCALL_CALL_ENDED\n");
    })();

    await withTimeout(
      cmdNotes(
        { command: "notes", notes_action: "transcript", doc_id: null },
        {
          docs: {
            appendText: async (docId, text) => {
              appended.push({ docId, text });
            },
            appendToSection: async () => {},
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
      appendFileSync(tf, "[2026-06-03 04:21:00] SAMOCALL_CALL_ENDED\n");
    })();

    await withTimeout(
      cmdNotes(
        { command: "notes", notes_action: "transcript", doc_id: "doc-arg", from_start: true },
        {
          docs: {
            appendText: async (_docId, text) => {
              texts.push(text);
            },
            appendToSection: async () => {},
          },
          watch: FAST,
        },
      ),
      4000,
    );

    expect(texts).toEqual(["[2026-06-03 04:20:00] Alice: existing\n"]);
  });
});
