/**
 * WS fan-out hub CORE (SPEC §5.5, §6.2 #3, §5.11) — RED stub.
 *
 * Pure, in-process, transport-agnostic. Real behaviour lands in the GREEN
 * commit; this stub only fixes the public surface so the tests compile and
 * fail loudly.
 */
const NOT_IMPLEMENTED = "ws-hub core not implemented yet";

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
/** Outbound queue byte cap (§5.5). */
export const MAX_QUEUE_BYTES = 512 * 1024;

/** Wire size of a data frame in bytes (UTF-8 JSON). */
export function frameBytes(_frame: DataFrame): number {
  throw new Error(NOT_IMPLEMENTED);
}

export class Subscriber {
  constructor(readonly callId: string) {}
  queueDepth(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  outstandingBytes(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  dropped(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  workOps(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  next(): OutboundFrame | undefined {
    throw new Error(NOT_IMPLEMENTED);
  }
  drain(): OutboundFrame[] {
    throw new Error(NOT_IMPLEMENTED);
  }
}

export class Hub {
  subscribe(_callId: string): Subscriber {
    throw new Error(NOT_IMPLEMENTED);
  }
  unsubscribe(_sub: Subscriber): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  publish(_callId: string, _frame: DataFrame): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  wsDroppedTotal(_callId: string): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  subscriberCount(_callId: string): number {
    throw new Error(NOT_IMPLEMENTED);
  }
}
