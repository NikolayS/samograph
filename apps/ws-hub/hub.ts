/**
 * WS fan-out hub CORE — pure, in-process, transport-agnostic (SPEC §5.5,
 * §6.2 #3, §5.11).
 *
 * One in-process pub/sub channel per `call_id`. Each subscriber owns a bounded
 * outbound queue capped by two INDEPENDENT limits — 256 messages OR 512 KB of
 * outstanding bytes, whichever fires first. On overflow the OLDEST data frames
 * are dropped, `ws_dropped_total{call_id}` is incremented, and exactly ONE
 * `{type:"gap", since_seq, until_seq}` control frame is enqueued (or extended)
 * to describe the contiguous dropped range so a client can REST-backfill it.
 *
 * Design notes:
 *  - The gap is a CONTROL frame: it does NOT count toward the 256-message or
 *    512 KB data caps. At most one gap is ever pending per subscriber (the
 *    current drop episode); it lives at the head of the outbound queue so it is
 *    delivered before the surviving data frames. Draining the gap closes the
 *    episode, so the next drop starts a fresh gap.
 *  - `publish` does O(subscribers) work and a bounded number of drops per
 *    frame; a stalled subscriber is bounded at the cap and never blocks others
 *    in the same channel (no head-of-line blocking).
 *
 * This is the transport-agnostic seam `publish(callId, frame)` that ingest
 * calls. The WS upgrade + authorizeCall + `?since_seq` replay (#83) and the
 * publisher-latency SLO benchmark (#87) layer on top of this and are NOT here.
 */

/** A data frame fanned out to subscribers. Carries a monotonic `seq`. */
export interface DataFrame {
  seq: number;
  [key: string]: unknown;
}

/** Control frame emitted on overflow so a client can REST-backfill the gap. */
export interface GapFrame {
  type: "gap";
  since_seq: number;
  until_seq: number;
}

/** Anything a subscriber can pull off its outbound queue. */
export type OutboundFrame = DataFrame | GapFrame;

/** Outbound queue message cap (§5.5). */
export const MAX_QUEUE_MESSAGES = 256;
/** Outbound queue byte cap (§5.5): 512 KiB. */
export const MAX_QUEUE_BYTES = 512 * 1024;

const ENCODER = new TextEncoder();

/** Wire size of a data frame in bytes (UTF-8 JSON). Deterministic, pure. */
export function frameBytes(frame: DataFrame): number {
  return ENCODER.encode(JSON.stringify(frame)).length;
}

/** Internal queue entry: a data frame (with cached size) or the gap control frame. */
type DataEntry = { kind: "data"; frame: DataFrame; bytes: number };
type GapEntry = { kind: "gap"; frame: GapFrame };
type Entry = DataEntry | GapEntry;

/**
 * A single subscriber's bounded outbound queue. Pull frames with `next()` /
 * `drain()`; never draining simulates a stalled client.
 */
export class Subscriber {
  /** Ordered outbound entries. When a gap is pending it sits at index 0. */
  private out: Entry[] = [];
  /** Outstanding DATA frames (gap excluded). */
  private dataCount = 0;
  /** Outstanding DATA bytes (gap excluded). */
  private dataBytes = 0;
  /** The pending gap entry for the current drop episode, or null. */
  private gap: GapEntry | null = null;
  /** Cumulative frames dropped on this subscriber (monotonic). */
  private droppedCount = 0;
  /** Logical enqueue/drop operations, for bounded-work assertions. */
  private ops = 0;

  constructor(readonly callId: string) {}

  /** Outstanding data-frame count (gap control frame excluded). */
  queueDepth(): number {
    return this.dataCount;
  }

  /** Outstanding data bytes (gap control frame excluded). */
  outstandingBytes(): number {
    return this.dataBytes;
  }

  /** Cumulative frames dropped on this subscriber. */
  dropped(): number {
    return this.droppedCount;
  }

  /** Logical enqueue + drop operations performed (bounded-work observability). */
  workOps(): number {
    return this.ops;
  }

  /** Total queued entries including a pending gap (observability). */
  pending(): number {
    return this.out.length;
  }

  /** Pull the next outbound frame in delivery order, or undefined if empty. */
  next(): OutboundFrame | undefined {
    const entry = this.out.shift();
    if (!entry) return undefined;
    if (entry.kind === "gap") {
      this.gap = null; // episode closed once the gap is delivered
      return entry.frame;
    }
    this.dataCount--;
    this.dataBytes -= entry.bytes;
    return entry.frame;
  }

  /** Drain every currently-queued frame, in delivery order. */
  drain(): OutboundFrame[] {
    const frames: OutboundFrame[] = [];
    for (let frame = this.next(); frame !== undefined; frame = this.next()) {
      frames.push(frame);
    }
    return frames;
  }

  /**
   * Enqueue a data frame, trimming oldest until both caps hold. Returns the
   * number of frames dropped so the hub can bump `ws_dropped_total{call_id}`.
   * Internal: driven by `Hub.publish`.
   */
  _enqueue(frame: DataFrame): number {
    const bytes = frameBytes(frame);
    this.out.push({ kind: "data", frame, bytes });
    this.dataCount++;
    this.dataBytes += bytes;
    this.ops++;

    let dropped = 0;
    // Trim while either cap is exceeded, but never drop the just-pushed frame
    // when it is the only data left (a lone > 512 KB frame is still delivered).
    while (
      (this.dataCount > MAX_QUEUE_MESSAGES || this.dataBytes > MAX_QUEUE_BYTES) &&
      this.dataCount > 1
    ) {
      this.dropOldest();
      dropped++;
    }
    return dropped;
  }

  /** Drop the oldest data frame and fold its seq into the head gap. */
  private dropOldest(): void {
    // When a gap is pending it occupies index 0, so the oldest data is index 1.
    const idx = this.gap ? 1 : 0;
    const removed = this.out[idx] as DataEntry;
    this.out.splice(idx, 1);
    this.dataCount--;
    this.dataBytes -= removed.bytes;
    this.droppedCount++;
    this.ops++;

    if (this.gap) {
      // Same contiguous episode: extend the existing gap's upper bound.
      this.gap.frame.until_seq = removed.frame.seq;
    } else {
      // New episode: open a fresh gap at the head of the queue.
      this.gap = {
        kind: "gap",
        frame: { type: "gap", since_seq: removed.frame.seq, until_seq: removed.frame.seq },
      };
      this.out.unshift(this.gap);
    }
  }
}

/**
 * In-process per-`call_id` pub/sub fan-out hub. Strict channel isolation: a
 * frame for call A is never delivered to a subscriber of call B.
 */
export class Hub {
  private channels = new Map<string, Set<Subscriber>>();
  /** Monotonic `ws_dropped_total{call_id}` counters, persisted across unsubscribe. */
  private droppedByCall = new Map<string, number>();

  /** Open a subscriber on a call's channel. */
  subscribe(callId: string): Subscriber {
    const sub = new Subscriber(callId);
    let subs = this.channels.get(callId);
    if (!subs) {
      subs = new Set();
      this.channels.set(callId, subs);
    }
    subs.add(sub);
    return sub;
  }

  /** Remove a subscriber from its channel (its drop counter stays counted). */
  unsubscribe(sub: Subscriber): void {
    const subs = this.channels.get(sub.callId);
    if (!subs) return;
    subs.delete(sub);
    if (subs.size === 0) this.channels.delete(sub.callId);
  }

  /**
   * Fan a frame out to every subscriber on `callId`. Bounded work per
   * subscriber; a stalled subscriber drops oldest rather than blocking others.
   */
  publish(callId: string, frame: DataFrame): void {
    const subs = this.channels.get(callId);
    if (!subs) return;
    for (const sub of subs) {
      const dropped = sub._enqueue(frame);
      if (dropped > 0) {
        this.droppedByCall.set(callId, (this.droppedByCall.get(callId) ?? 0) + dropped);
      }
    }
  }

  /** `ws_dropped_total{call_id}` — total frames dropped across the call's subscribers. */
  wsDroppedTotal(callId: string): number {
    return this.droppedByCall.get(callId) ?? 0;
  }

  /** Live subscriber count on a channel (observability). */
  subscriberCount(callId: string): number {
    return this.channels.get(callId)?.size ?? 0;
  }
}
