import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleWebhook, serve } from "../src/server.ts";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";

function makeTranscriptEvent(
  speaker: string,
  words: string[],
  timestamp = "2024-01-15T10:30:45.000Z",
): unknown {
  return {
    event: "transcript.data",
    data: {
      data: {
        participant: { name: speaker },
        words: words.map((w) => ({
          text: w,
          start_timestamp: { absolute: timestamp },
        })),
      },
    },
  };
}

describe("webhook handler", () => {
  let tmp: string;
  let tf: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
  });
  afterEach(() => {
    cleanupTmpDir(tmp);
  });

  it("transcript event writes line", async () => {
    await handleWebhook(makeTranscriptEvent("Alice", ["Hello", "world"]), tf);
    const lines = readFileSync(tf, "utf-8").split("\n").filter((l) => l);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Alice");
    expect(lines[0]).toContain("Hello world");
  });

  it("line format: timestamp speaker text", async () => {
    await handleWebhook(
      makeTranscriptEvent("Bob", ["Nice", "to", "meet", "you"], "2024-03-20T14:05:30.123Z"),
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toBe(
      "[2024-03-20 14:05:30] Bob: Nice to meet you",
    );
  });

  it("multiple words joined with spaces", async () => {
    await handleWebhook(
      makeTranscriptEvent("Carol", ["one", "two", "three", "four", "five"]),
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toContain("one two three four five");
  });

  it("unknown event ignored", async () => {
    await handleWebhook({ event: "some.other.event", data: {} }, tf);
    expect(readFileSync(tf, "utf-8")).toBe("");
  });

  it("missing event field ignored", async () => {
    await handleWebhook({ data: {} }, tf);
    expect(readFileSync(tf, "utf-8")).toBe("");
  });

  it("empty words list not written", async () => {
    await handleWebhook(
      {
        event: "transcript.data",
        data: { data: { participant: { name: "Dan" }, words: [] } },
      },
      tf,
    );
    expect(readFileSync(tf, "utf-8")).toBe("");
  });

  it("multiple events appended", async () => {
    await handleWebhook(makeTranscriptEvent("A", ["first"]), tf);
    await handleWebhook(makeTranscriptEvent("B", ["second"]), tf);
    await handleWebhook(makeTranscriptEvent("C", ["third"]), tf);
    const lines = readFileSync(tf, "utf-8").split("\n").filter((l) => l);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
    expect(lines[2]).toContain("third");
  });

  it("missing speaker defaults to question mark", async () => {
    await handleWebhook(
      {
        event: "transcript.data",
        data: {
          data: {
            words: [
              { text: "hi", start_timestamp: { absolute: "2024-01-01T00:00:00Z" } },
            ],
          },
        },
      },
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toBe("[2024-01-01 00:00:00] ?: hi");
  });

  it("timestamp truncated to seconds", async () => {
    await handleWebhook(
      makeTranscriptEvent("Eve", ["test"], "2025-12-31T23:59:59.999999Z"),
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toStartWith(
      "[2025-12-31 23:59:59]",
    );
  });

  it("Bun.serve round trip POST /webhook", async () => {
    const server = serve(0, tf);
    try {
      const resp = await fetch(`http://localhost:${server.port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTranscriptEvent("Zed", ["roundtrip"])),
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
      expect(readFileSync(tf, "utf-8")).toContain("Zed: roundtrip");
    } finally {
      server.stop(true);
    }
  });
});
