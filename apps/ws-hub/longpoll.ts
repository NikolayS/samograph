// RED stub — implementation lands in the GREEN commit.
import type { SQL } from "bun";
import type { AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import type { RequestRateCaps } from "./caps.ts";
import type { TranscriptLine } from "./transcript.ts";

export const LONGPOLL_DEFAULT_WAIT_S = 25;
export const LONGPOLL_MAX_WAIT_S = 50;
export const LONGPOLL_MAX_LINES = 500;

export interface LineWaiter {
  promise: Promise<void>;
  cancel(): void;
}

export class LineWaiters {
  register(_callId: string): LineWaiter {
    return { promise: new Promise<void>(() => {}), cancel() {} };
  }
  notify(_callId: string): void {}
  size(_callId?: string): number {
    return 0;
  }
}

export interface LongPollDeps {
  sql: SQL;
  authDeps: AuthorizeDeps;
  waiters: LineWaiters;
  restCaps?: RequestRateCaps;
  clockMs?: () => number;
  recheckMs?: number;
  maxLines?: number;
  coalesceMs?: number;
}

export interface LongPollResponseBody {
  call_id: string;
  since_seq: number;
  next_seq: number;
  lines: TranscriptLine[];
}

export function parseWaitSeconds(_url: URL): number {
  return 0;
}

export function createLongPollHandler(_deps: LongPollDeps): (req: Request) => Promise<Response> {
  return async () => new Response(null, { status: 501 });
}
