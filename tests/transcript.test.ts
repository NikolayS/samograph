import { describe, it, expect } from "bun:test";
import { formatTranscriptLine, SENTINEL_RE } from "../src/transcript.ts";

function event(
  speaker: string | null,
  words: string[],
  ts = "2024-01-15T10:30:45.000Z",
): unknown {
  const inner: Record<string, unknown> = {
    words: words.map((w) => ({ text: w, start_timestamp: { absolute: ts } })),
  };
  if (speaker !== null) inner.participant = { name: speaker };
  return { event: "transcript.data", data: { data: inner } };
}

describe("formatTranscriptLine", () => {
  it("formats timestamp speaker text", () => {
    expect(formatTranscriptLine(event("Bob", ["Nice", "to", "meet"]))).toBe(
      "[2024-01-15 10:30:45] Bob: Nice to meet",
    );
  });

  it("returns null for non transcript.data event", () => {
    expect(formatTranscriptLine({ event: "other.event", data: {} })).toBeNull();
  });

  it("returns null when no event field", () => {
    expect(formatTranscriptLine({ data: {} })).toBeNull();
  });

  it("returns null when words empty", () => {
    expect(
      formatTranscriptLine({
        event: "transcript.data",
        data: { data: { participant: { name: "X" }, words: [] } },
      }),
    ).toBeNull();
  });

  it("defaults speaker to ?", () => {
    expect(
      formatTranscriptLine(event(null, ["hi"], "2024-01-01T00:00:00Z")),
    ).toBe("[2024-01-01 00:00:00] ?: hi");
  });

  it("truncates milliseconds", () => {
    expect(
      formatTranscriptLine(event("Eve", ["x"], "2025-12-31T23:59:59.999999Z")),
    ).toBe("[2025-12-31 23:59:59] Eve: x");
  });

  it("returns null for empty payload", () => {
    expect(formatTranscriptLine({})).toBeNull();
    expect(formatTranscriptLine(null)).toBeNull();
  });

  it("produces empty timestamp bracket when start_timestamp is absent", () => {
    const line = formatTranscriptLine({
      event: "transcript.data",
      data: {
        data: {
          participant: { name: "Dan" },
          words: [{ text: "hello" }],
        },
      },
    });
    expect(line).toBe("[] Dan: hello");
  });

  it("produces empty timestamp bracket when absolute is undefined", () => {
    const line = formatTranscriptLine({
      event: "transcript.data",
      data: {
        data: {
          participant: { name: "Eve" },
          words: [{ text: "hi", start_timestamp: {} }],
        },
      },
    });
    expect(line).toBe("[] Eve: hi");
  });
});

describe("SENTINEL_RE", () => {
  it("matches anchored sentinel", () => {
    expect(
      SENTINEL_RE.test("[2026-05-28 10:05:00] SAMOGRAPH_CALL_ENDED"),
    ).toBe(true);
  });

  it("does not match speaker-prefixed phrase", () => {
    expect(
      SENTINEL_RE.test(
        "[2026-05-28 10:00:00] Bob: please run SAMOGRAPH_CALL_ENDED now",
      ),
    ).toBe(false);
  });

  it("does not match bare phrase", () => {
    expect(SENTINEL_RE.test("SAMOGRAPH_CALL_ENDED")).toBe(false);
  });
});
