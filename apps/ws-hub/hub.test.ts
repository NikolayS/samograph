import { describe, it, expect } from "bun:test";
import {
  Hub,
  frameBytes,
  MAX_QUEUE_MESSAGES,
  MAX_QUEUE_BYTES,
  type DataFrame,
  type GapFrame,
  type OutboundFrame,
} from "./hub.ts";

// --- helpers -------------------------------------------------------------

/** Small data frame carrying a monotonic seq. */
function f(seq: number): DataFrame {
  return { seq };
}

/** Type guard for the gap control frame. */
function isGap(frame: OutboundFrame): frame is GapFrame {
  return (frame as GapFrame).type === "gap";
}

/** The data frames in a drained output, in delivery order. */
function dataSeqs(frames: OutboundFrame[]): number[] {
  return frames.filter((x) => !isGap(x)).map((x) => (x as DataFrame).seq);
}

/** The gap control frames in a drained output, in delivery order. */
function gaps(frames: OutboundFrame[]): GapFrame[] {
  return frames.filter(isGap) as GapFrame[];
}

// --- constants -----------------------------------------------------------

describe("ws-hub caps", () => {
  it("exposes the dual caps from §5.5: 256 messages OR 512 KB", () => {
    expect(MAX_QUEUE_MESSAGES).toBe(256);
    expect(MAX_QUEUE_BYTES).toBe(512 * 1024);
  });
});

// --- AC #1: message cap, drop-oldest, counter -----------------------------

describe("ws-hub message cap (AC #1)", () => {
  it("publishing 257 frames leaves exactly 256 outstanding (oldest dropped), ws_dropped_total==1", () => {
    const hub = new Hub();
    const sub = hub.subscribe("call-A");

    for (let seq = 1; seq <= 257; seq++) hub.publish("call-A", f(seq));

    expect(sub.queueDepth()).toBe(256);
    expect(sub.dropped()).toBe(1);
    expect(hub.wsDroppedTotal("call-A")).toBe(1);

    const out = sub.drain();
    // One gap control frame at the head describing the single dropped seq=1,
    // followed by the surviving data frames seq 2..257 in order.
    expect(out[0]).toEqual({ type: "gap", since_seq: 1, until_seq: 1 });
    expect(dataSeqs(out)).toEqual(Array.from({ length: 256 }, (_, i) => i + 2));
    expect(gaps(out)).toHaveLength(1);
  });

  it("256 frames fit with zero drops and no gap frame", () => {
    const hub = new Hub();
    const sub = hub.subscribe("call-A");
    for (let seq = 1; seq <= 256; seq++) hub.publish("call-A", f(seq));

    expect(sub.queueDepth()).toBe(256);
    expect(sub.dropped()).toBe(0);
    expect(hub.wsDroppedTotal("call-A")).toBe(0);
    expect(gaps(sub.drain())).toHaveLength(0);
  });
});

// --- AC #2: byte cap fires before message cap -----------------------------

describe("ws-hub byte cap (AC #2)", () => {
  it("512 KB outstanding triggers overflow well before 256 messages when frames are large", () => {
    const hub = new Hub();
    const sub = hub.subscribe("call-A");

    // Each frame is exactly 100 KiB (102400 B) on the wire. 512 KiB / 100 KiB
    // => 5 frames fit (512000 B <= 524288 B), the 6th overflows by bytes long
    // before the 256-message cap could ever fire.
    const PAYLOAD = 102400 - frameBytes({ seq: 1, p: "" });
    const big = (seq: number): DataFrame => ({ seq, p: "x".repeat(PAYLOAD) });
    expect(frameBytes(big(1))).toBe(102400);

    for (let seq = 1; seq <= 6; seq++) hub.publish("call-A", big(seq));

    expect(sub.queueDepth()).toBe(5); // byte cap, not the 256 message cap
    expect(sub.outstandingBytes()).toBe(5 * 102400);
    expect(sub.outstandingBytes()).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(sub.dropped()).toBe(1);
    expect(hub.wsDroppedTotal("call-A")).toBe(1);

    const out = sub.drain();
    expect(gaps(out)).toEqual([{ type: "gap", since_seq: 1, until_seq: 1 }]);
    expect(dataSeqs(out)).toEqual([2, 3, 4, 5, 6]);
  });
});

// --- AC #3: exactly one gap per contiguous episode; fresh gap after drain --

describe("ws-hub gap frame episodes (AC #3)", () => {
  it("emits exactly one gap covering the full contiguous dropped range", () => {
    const hub = new Hub();
    const sub = hub.subscribe("call-A");

    // 300 frames, never drained: drops the oldest 44 (seq 1..44).
    for (let seq = 1; seq <= 300; seq++) hub.publish("call-A", f(seq));

    expect(sub.dropped()).toBe(44);
    const out = sub.drain();
    expect(gaps(out)).toEqual([{ type: "gap", since_seq: 1, until_seq: 44 }]);
    expect(dataSeqs(out)).toEqual(Array.from({ length: 256 }, (_, i) => i + 45));
  });

  it("a fresh drop episode after a drain emits a brand new gap frame", () => {
    const hub = new Hub();
    const sub = hub.subscribe("call-A");

    for (let seq = 1; seq <= 300; seq++) hub.publish("call-A", f(seq));
    const episode1 = sub.drain();
    expect(gaps(episode1)).toEqual([{ type: "gap", since_seq: 1, until_seq: 44 }]);
    expect(sub.queueDepth()).toBe(0);

    // Second episode from an empty queue: 260 frames => drop oldest 4 (301..304).
    for (let seq = 301; seq <= 560; seq++) hub.publish("call-A", f(seq));
    const episode2 = sub.drain();
    expect(gaps(episode2)).toEqual([{ type: "gap", since_seq: 301, until_seq: 304 }]);
    expect(dataSeqs(episode2)).toEqual(Array.from({ length: 256 }, (_, i) => i + 305));

    expect(sub.dropped()).toBe(48); // 44 + 4 cumulative
    expect(hub.wsDroppedTotal("call-A")).toBe(48);
  });
});

// --- AC #4: a stalled subscriber never blocks a healthy one ---------------

describe("ws-hub head-of-line isolation (AC #4)", () => {
  it("a stalled subscriber does not delay another subscriber on the same call", () => {
    const hub = new Hub();
    const healthy = hub.subscribe("call-A");
    const stalled = hub.subscribe("call-A");

    const received: number[] = [];
    const N = 1000;
    for (let seq = 1; seq <= N; seq++) {
      hub.publish("call-A", f(seq));
      // Healthy subscriber drains every tick; stalled one never does.
      let frame: OutboundFrame | undefined;
      while ((frame = healthy.next()) !== undefined) {
        if (!isGap(frame)) received.push(frame.seq);
      }
    }

    // The healthy subscriber saw every frame, in order, with no drops/gaps.
    expect(received).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(healthy.dropped()).toBe(0);
    expect(healthy.queueDepth()).toBe(0);

    // The stalled subscriber is bounded: it kept the newest 256 and dropped the
    // rest behind a single gap. It never grew without bound (no blocking).
    expect(stalled.queueDepth()).toBe(MAX_QUEUE_MESSAGES);
    expect(stalled.dropped()).toBe(N - MAX_QUEUE_MESSAGES); // 744
    const out = stalled.drain();
    expect(gaps(out)).toEqual([{ type: "gap", since_seq: 1, until_seq: N - MAX_QUEUE_MESSAGES }]);
    expect(dataSeqs(out)).toEqual(Array.from({ length: 256 }, (_, i) => i + (N - 255)));

    // Bounded publisher work: total enqueue/drop ops on the stalled subscriber
    // are linear in N (no head-of-line / quadratic blowup).
    expect(stalled.workOps()).toBeLessThanOrEqual(2 * N);
  });
});

// --- AC #5: cross-channel isolation ---------------------------------------

describe("ws-hub channel isolation (AC #5)", () => {
  it("a subscriber on call B receives nothing published to call A", () => {
    const hub = new Hub();
    const subA = hub.subscribe("call-A");
    const subB = hub.subscribe("call-B");

    for (let seq = 1; seq <= 10; seq++) hub.publish("call-A", f(seq));

    expect(subB.queueDepth()).toBe(0);
    expect(subB.drain()).toEqual([]);
    expect(hub.wsDroppedTotal("call-B")).toBe(0);

    expect(subA.queueDepth()).toBe(10);
    expect(dataSeqs(subA.drain())).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("unsubscribe stops delivery without disturbing the rest of the channel", () => {
    const hub = new Hub();
    const a = hub.subscribe("call-A");
    const b = hub.subscribe("call-A");
    expect(hub.subscriberCount("call-A")).toBe(2);

    hub.unsubscribe(a);
    expect(hub.subscriberCount("call-A")).toBe(1);

    hub.publish("call-A", f(1));
    expect(a.queueDepth()).toBe(0);
    expect(b.queueDepth()).toBe(1);
  });
});
