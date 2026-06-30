/**
 * `TranscriptPublisher` port — pure tests for the in-memory fake + the
 * per-call channel keying (SPEC §5.5 "one pub/sub channel per call_id", §5.11).
 *
 * The fake is what ingest's transcript pipeline (#78), the watchdog (#81) and
 * lifecycle (#79) publish onto, and what ws-hub (#83) consumes — so these tests
 * pin the seam contract with NO Postgres, NO ws-hub, NO tokens.
 */
import { describe, it, expect } from "bun:test";
import {
  InMemoryTranscriptPublisher,
  createInMemoryTranscriptPublisher,
  transcriptChannel,
  type TranscriptControlFrame,
  type TranscriptLineFrame,
} from "./publisher.ts";

const lineFrame = (call_id: string, seq: number): TranscriptLineFrame => ({
  type: "line",
  call_id,
  seq,
  ts: "2026-01-01 00:01:30",
  speaker: "Alice",
  text: `line ${seq}`,
});

describe("TranscriptPublisher in-memory fake (§5.5)", () => {
  it("records every published frame in publish order", () => {
    const pub = createInMemoryTranscriptPublisher();
    pub.publish(lineFrame("call-A", 1));
    pub.publish(lineFrame("call-A", 2));

    expect(pub.published).toEqual([lineFrame("call-A", 1), lineFrame("call-A", 2)]);
  });

  it("publishes a line frame as exactly {type,call_id,seq,ts,speaker,text}", () => {
    const pub = new InMemoryTranscriptPublisher();
    pub.publish(lineFrame("call-A", 7));
    expect(pub.published[0]).toEqual({
      type: "line",
      call_id: "call-A",
      seq: 7,
      ts: "2026-01-01 00:01:30",
      speaker: "Alice",
      text: "line 7",
    });
  });

  it("keys frames per call_id — a subscriber on call B never sees call A's lines (§5.5 isolation)", () => {
    const pub = new InMemoryTranscriptPublisher();
    pub.publish(lineFrame("call-A", 1));
    pub.publish(lineFrame("call-B", 1));
    pub.publish(lineFrame("call-A", 2));

    expect(pub.linesFor("call-A").map((f) => f.seq)).toEqual([1, 2]);
    expect(pub.linesFor("call-B").map((f) => f.seq)).toEqual([1]);
    // Strict isolation: nothing from A leaks into B's channel and vice-versa.
    expect(pub.framesFor("call-B").every((f) => f.call_id === "call-B")).toBe(true);
    expect(pub.framesFor("call-A").every((f) => f.call_id === "call-A")).toBe(true);
  });

  it("carries control frames (tunnel warning / status) on the same per-call channel", () => {
    const pub = new InMemoryTranscriptPublisher();
    const warning: TranscriptControlFrame = {
      type: "warning",
      call_id: "call-A",
      text: "tunnel unreachable (ERR_NGROK_727)",
    };
    pub.publish(lineFrame("call-A", 1));
    pub.publish(warning);

    expect(pub.framesFor("call-A")).toEqual([lineFrame("call-A", 1), warning]);
    // Control frames are not lines.
    expect(pub.linesFor("call-A").map((f) => f.seq)).toEqual([1]);
  });
});

describe("transcriptChannel — one LISTEN/NOTIFY channel per call_id (§5.5)", () => {
  it("derives a distinct, ≤63-byte channel per call_id", () => {
    const callId = "11111111-1111-1111-1111-111111111111";
    expect(transcriptChannel(callId)).toBe(`transcript:${callId}`);
    // Postgres channel names cap at NAMEDATALEN-1 (63 bytes).
    expect(transcriptChannel(callId).length).toBeLessThanOrEqual(63);
    expect(transcriptChannel("call-A")).not.toBe(transcriptChannel("call-B"));
  });
});
