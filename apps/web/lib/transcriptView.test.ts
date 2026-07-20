import { describe, it, expect } from "bun:test";
import {
  formatRenderLine,
  initialTranscriptState,
  transcriptReducer,
  type TranscriptLine,
  type TranscriptViewEvent,
  type TranscriptViewState,
} from "./transcriptView.ts";

const TS = "2026-01-01 00:01:30";

function reduce(
  state: TranscriptViewState,
  events: TranscriptViewEvent[],
): TranscriptViewState {
  return events.reduce(transcriptReducer, state);
}

function line(
  seq: number,
  text: string,
  final: boolean,
  speaker = "Alice",
): TranscriptViewEvent {
  return { type: "line", seq, ts: TS, speaker, text, final };
}

const UNREACHABLE =
  "tunnel unreachable (ERR_NGROK_727) - transcript may be incomplete; rejoin with --tunnel cloudflared";

describe("transcriptReducer — partial / final lines (SPEC §5.5)", () => {
  it("a partial then its final yields exactly one finalized line, no partial, no dupe", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      line(1, "hel", false),
      line(1, "hello world", true),
    ]);
    expect(next.lines).toEqual([
      { seq: 1, ts: TS, speaker: "Alice", text: "hello world" },
    ]);
    expect(next.partial).toBeNull();
  });

  it("a second partial replaces the first (only the latest trailing partial is held)", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      line(5, "foo", false),
      line(5, "foobar", false),
    ]);
    expect(next.partial).toEqual({ seq: 5, ts: TS, speaker: "Alice", text: "foobar" });
    expect(next.lines).toEqual([]);
  });

  it("sorts out-of-order final seqs ascending and treats a re-applied seq as a no-op (idempotent replay)", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      line(3, "c", true),
      line(1, "a", true),
      line(3, "c", true), // replay of an already-applied seq
    ]);
    expect(next.lines).toEqual([
      { seq: 1, ts: TS, speaker: "Alice", text: "a" },
      { seq: 3, ts: TS, speaker: "Alice", text: "c" },
    ]);
  });

  it("a replayed final does NOT clobber an unrelated active partial", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      line(1, "first", true),
      line(2, "typing", false), // active partial, seq 2
      line(1, "first", true), // replay of seq 1
    ]);
    expect(next.lines).toEqual([
      { seq: 1, ts: TS, speaker: "Alice", text: "first" },
    ]);
    expect(next.partial).toEqual({ seq: 2, ts: TS, speaker: "Alice", text: "typing" });
  });
});

describe("transcriptReducer — gap → backfill (SPEC §5.5 ?since_seq)", () => {
  it("a gap records the pending backfill range", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      line(1, "one", true),
      line(5, "five", true),
      { type: "gap", sinceSeq: 2, untilSeq: 4 },
    ]);
    expect(next.pendingBackfill).toEqual({ sinceSeq: 2, untilSeq: 4 });
  });

  it("applying a backfill fills exactly the missing range, sorted, with no dupes, and clears the pending flag", () => {
    const backfill: TranscriptLine[] = [
      { seq: 2, ts: TS, speaker: "Bob", text: "two" },
      { seq: 3, ts: TS, speaker: "Bob", text: "three" },
      { seq: 4, ts: TS, speaker: "Bob", text: "four" },
      { seq: 1, ts: TS, speaker: "Alice", text: "one" }, // overlaps an already-present line
    ];
    const next = reduce(initialTranscriptState("IN_CALL"), [
      line(1, "one", true),
      line(5, "five", true),
      { type: "gap", sinceSeq: 2, untilSeq: 4 },
      { type: "backfill", lines: backfill },
    ]);
    expect(next.lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(next.lines.map((l) => l.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
    ]);
    expect(next.pendingBackfill).toBeNull();
  });
});

describe("transcriptReducer — degraded dual-driver (SPEC §3 Story 5, §4.5, §5.10)", () => {
  it("a SAMOGRAPH-WARNING 'tunnel unreachable' line sets degraded=true and is appended inline", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      line(1, "hi", true),
      { type: "line", seq: 2, ts: TS, speaker: "SAMOGRAPH-WARNING", text: UNREACHABLE, final: true },
    ]);
    expect(next.degraded).toBe(true);
    expect(next.lines).toEqual([
      { seq: 1, ts: TS, speaker: "Alice", text: "hi" },
      { seq: 2, ts: TS, speaker: "SAMOGRAPH-WARNING", text: UNREACHABLE },
    ]);
  });

  it("a SAMOGRAPH-WARNING 'tunnel recovered' line clears degraded", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      { type: "line", seq: 1, ts: TS, speaker: "SAMOGRAPH-WARNING", text: UNREACHABLE, final: true },
      { type: "line", seq: 2, ts: TS, speaker: "SAMOGRAPH-WARNING", text: "tunnel recovered", final: true },
    ]);
    expect(next.degraded).toBe(false);
  });

  it("an `ingest_degraded` overlay event drives degraded independently of warning lines", () => {
    const on = transcriptReducer(initialTranscriptState("IN_CALL"), {
      type: "degraded",
      degraded: true,
    });
    expect(on.degraded).toBe(true);
    const off = transcriptReducer(on, { type: "degraded", degraded: false });
    expect(off.degraded).toBe(false);
  });

  it("a terminal status transition resets the degraded overlay (SPEC §5.2)", () => {
    const degraded = transcriptReducer(initialTranscriptState("IN_CALL"), {
      type: "degraded",
      degraded: true,
    });
    expect(degraded.degraded).toBe(true);
    const ended = transcriptReducer(degraded, { type: "status", status: "ENDED" });
    expect(ended.status).toBe("ENDED");
    expect(ended.degraded).toBe(false);
  });

  it("a non-terminal status transition leaves the degraded overlay untouched", () => {
    const degraded = transcriptReducer(initialTranscriptState("JOINING"), {
      type: "degraded",
      degraded: true,
    });
    const inCall = transcriptReducer(degraded, { type: "status", status: "IN_CALL" });
    expect(inCall.status).toBe("IN_CALL");
    expect(inCall.degraded).toBe(true);
  });
});

describe("transcriptReducer — connection liveness", () => {
  it("open marks connected, closed clears it", () => {
    const open = transcriptReducer(initialTranscriptState("IN_CALL"), { type: "open" });
    expect(open.connected).toBe(true);
    const closed = transcriptReducer(open, { type: "closed", code: 1006, reason: "x" });
    expect(closed.connected).toBe(false);
  });
});

describe("formatRenderLine — byte-identical to the CLI (SPEC §5.4)", () => {
  it("renders `[ts] Speaker: text`", () => {
    expect(
      formatRenderLine({ seq: 1, ts: TS, speaker: "Alice", text: "hello world" }),
    ).toBe("[2026-01-01 00:01:30] Alice: hello world");
  });

  it("renders a SAMOGRAPH-WARNING line in the same shape", () => {
    expect(
      formatRenderLine({ seq: 2, ts: TS, speaker: "SAMOGRAPH-WARNING", text: "tunnel recovered" }),
    ).toBe("[2026-01-01 00:01:30] SAMOGRAPH-WARNING: tunnel recovered");
  });

  it("renders a chat line with the ` (chat)` marker after the name (#195)", () => {
    expect(
      formatRenderLine({ seq: 3, ts: TS, speaker: "Alice", text: "hello everyone", kind: "chat" }),
    ).toBe("[2026-01-01 00:01:30] Alice (chat): hello everyone");
  });

  it("a speech (or kind-less) line renders with NO marker — backward compatible", () => {
    expect(formatRenderLine({ seq: 4, ts: TS, speaker: "Bob", text: "spoke", kind: "speech" })).toBe(
      "[2026-01-01 00:01:30] Bob: spoke",
    );
  });
});

describe("transcriptReducer — chat lines carry kind end-to-end (#195)", () => {
  it("a chat line event finalizes to a line whose kind='chat' (rendered with the marker)", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      { type: "line", seq: 1, ts: TS, speaker: "Alice", text: "typed this", final: true, kind: "chat" },
    ]);
    expect(next.lines).toEqual([{ seq: 1, ts: TS, speaker: "Alice", text: "typed this", kind: "chat" }]);
    expect(formatRenderLine(next.lines[0])).toBe("[2026-01-01 00:01:30] Alice (chat): typed this");
  });

  it("a speech line event finalizes WITHOUT a kind field (byte-identical to pre-#195)", () => {
    const next = reduce(initialTranscriptState("IN_CALL"), [
      { type: "line", seq: 2, ts: TS, speaker: "Bob", text: "spoke", final: true },
    ]);
    expect(next.lines).toEqual([{ seq: 2, ts: TS, speaker: "Bob", text: "spoke" }]);
    expect("kind" in next.lines[0]).toBe(false);
  });
});
