/**
 * `samograph watch --remote <site> --call <id> --mode longpoll` — tunnel-free
 * transcript delivery (issue #307, prototype 2/3).
 *
 * The laptop makes OUTBOUND requests only: `GET <site>/calls/<id>/lines?since_seq=N&wait=S`.
 * The site answers at once when lines after cursor N exist, else holds the
 * request up to `wait` seconds. The client always asks for "everything after the
 * cursor" — never a fixed tail — so fast speech leaves no holes and slow speech
 * never re-floods the agent with repeats.
 *
 *   • each line is printed as `[ts] Speaker: text` (the CLI transcript format)
 *     and appended to the local transcript file;
 *   • the cursor advances per line; a seq ≤ cursor is never re-emitted;
 *   • request timeout = wait + 10 s; 5xx / network errors / timeouts back off
 *     with full jitter and RESUME from the cursor (exactly-once, in order);
 *   • 429 honours Retry-After; 401/403 stop with a clear message.
 *
 * The share token rides ONLY in `Authorization: Bearer …`; it is never put in a
 * URL and never logged.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renderTranscriptLine } from "../packages/shared/transcript/index.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_WAIT_S = 25;
export const MAX_WAIT_S = 50;
/** Environment variable the CLI reads the share token from (never argv). */
export const TOKEN_ENV = "SAMOGRAPH_CALL_TOKEN";

export interface RemoteLongPollOpts {
  baseUrl: string;
  callId: string;
  token: string;
  /** Resume cursor: deliver lines with seq > sinceSeq (default 0 = from the start). */
  sinceSeq?: number;
  waitS?: number;
  /** Append each rendered line here; null disables file output. */
  transcriptFile?: string | null;
  /** Called per new line (default: print to stdout). */
  onLine?: (line: string, seq: number) => void | Promise<void>;
  /** Diagnostics sink (default: stderr). Never receives the token. */
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
  /** The last delivered seq — pass back as `sinceSeq` to resume. */
  sinceSeq: number;
  requests: number;
  errors: number;
}

interface WireLine {
  seq: number;
  ts: string;
  speaker: string | null;
  text: string;
  kind?: "chat" | "speech";
}

/** The long-poll URL. Carries only the cursor + wait — never a credential. */
export function longPollUrl(base: string, callId: string, since: number, waitS: number): string {
  const root = base.replace(/\/+$/, "");
  return `${root}/calls/${encodeURIComponent(callId)}/lines?since_seq=${since}&wait=${waitS}`;
}

/** Client-side request timeout: the server's hold plus 10 s of slack. */
export function clientTimeoutMs(waitS: number): number {
  return (waitS + 10) * 1000;
}

/** Exponential backoff with full jitter: floor(random · min(max, base · 2^attempt)). */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  return Promise.race([
    sleep(ms),
    new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })),
  ]);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "request timed out" : err.message;
  return String(err);
}

/** Run the long-poll loop until aborted, unauthorized, or a client-side 400. */
export async function watchRemoteLongPoll(opts: RemoteLongPollOpts): Promise<RemoteWatchResult> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const log = opts.log ?? ((m: string) => void process.stderr.write(m + "\n"));
  const onLine = opts.onLine ?? ((line: string) => void process.stdout.write(line + "\n"));
  const waitS = Math.min(Math.max(0, opts.waitS ?? DEFAULT_WAIT_S), MAX_WAIT_S);
  const baseMs = opts.backoffBaseMs ?? 500;
  const maxMs = opts.backoffMaxMs ?? 30_000;
  const file = opts.transcriptFile ?? null;
  if (file) mkdirSync(dirname(file), { recursive: true });

  let cursor = opts.sinceSeq ?? 0;
  let requests = 0;
  let errors = 0;
  let attempt = 0;
  const done = (stopReason: RemoteWatchResult["stopReason"]): RemoteWatchResult => ({
    stopReason,
    sinceSeq: cursor,
    requests,
    errors,
  });

  const retry = async (why: string) => {
    errors += 1;
    const delay = backoffDelayMs(attempt, baseMs, maxMs, random);
    attempt += 1;
    log(`[samograph] remote watch error: ${why}; retry in ${delay} ms from seq ${cursor}`);
    await abortableSleep(sleep, delay, opts.signal);
  };

  while (!opts.signal?.aborted) {
    const timeout = AbortSignal.timeout(clientTimeoutMs(waitS));
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    requests += 1;
    let res: Response;
    try {
      res = await doFetch(longPollUrl(opts.baseUrl, opts.callId, cursor, waitS), {
        method: "GET",
        headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" },
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) break;
      await retry(describeError(err));
      continue;
    }

    if (res.status === 200) {
      let lines: WireLine[];
      try {
        lines = ((await res.json()) as { lines?: WireLine[] }).lines ?? [];
      } catch (err) {
        if (opts.signal?.aborted) break;
        await retry(`bad response body (${describeError(err)})`);
        continue;
      }
      attempt = 0;
      for (const l of lines) {
        if (!(l.seq > cursor)) continue; // exactly-once: never re-emit ≤ cursor
        const rendered = renderTranscriptLine(l);
        if (file) appendFileSync(file, rendered + "\n");
        cursor = l.seq;
        await onLine(rendered, l.seq);
      }
      continue;
    }

    // Drain the body so the connection can be reused (never logged).
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) {
      log(
        `[samograph] remote watch stopped: access denied (HTTP ${res.status}). ` +
          `The share token in ${TOKEN_ENV} is invalid, expired, revoked, or not for call ${opts.callId}.`,
      );
      return done("unauthorized");
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffDelayMs(attempt++, baseMs, maxMs, random);
      log(`[samograph] remote watch rate-limited (HTTP 429); retry in ${delay} ms from seq ${cursor}`);
      await abortableSleep(sleep, delay, opts.signal);
      continue;
    }
    if (res.status >= 500) {
      await retry(`HTTP ${res.status}`);
      continue;
    }
    log(`[samograph] remote watch stopped: unexpected HTTP ${res.status} from ${opts.baseUrl}`);
    return done("bad_request");
  }
  return done("aborted");
}
