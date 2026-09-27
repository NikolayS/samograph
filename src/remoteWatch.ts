// RED stub — implementation lands in the GREEN commit.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteLongPollOpts {
  baseUrl: string;
  callId: string;
  token: string;
  sinceSeq?: number;
  waitS?: number;
  transcriptFile?: string | null;
  onLine?: (line: string, seq: number) => void | Promise<void>;
  log?: (msg: string) => void;
  fetch?: FetchLike;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface RemoteWatchResult {
  stopReason: "unauthorized" | "aborted" | "bad_request";
  sinceSeq: number;
  requests: number;
  errors: number;
}

export function longPollUrl(_base: string, _callId: string, _since: number, _waitS: number): string {
  return "";
}

export function clientTimeoutMs(_waitS: number): number {
  return 0;
}

export function backoffDelayMs(_attempt: number, _baseMs: number, _maxMs: number, _random: () => number): number {
  return 0;
}

export async function watchRemoteLongPoll(opts: RemoteLongPollOpts): Promise<RemoteWatchResult> {
  return { stopReason: "aborted", sinceSeq: opts.sinceSeq ?? 0, requests: 0, errors: 0 };
}
