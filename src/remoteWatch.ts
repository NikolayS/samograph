/**
 * `samograph watch --remote <site> --call <id>` — #307 prototype 1: PLAIN POLLING.
 *
 * Instead of tailing a local transcript file fed by a public tunnel, the CLI
 * makes OUTBOUND requests to the hosted site every `intervalMs` (default 2 s):
 *
 *     GET <site>/calls/<id>/transcript?since_seq=<cursor>
 *     Authorization: Bearer <per-call share token>
 *
 * The per-call `seq` is gap-free and monotonic, so the cursor is the whole
 * resume story: ask for "everything after X" (never a fixed tail), emit each
 * line once, advance X, and drop anything with `seq <= X` defensively.
 *
 * Errors: 401/403 stop immediately ({@link RemoteAuthError}); 429 sleeps for
 * `Retry-After`; 5xx / network errors back off exponentially with jitter and
 * retry from the SAME cursor. The token lives only in the Authorization header
 * and is redacted from every log line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { renderTranscriptLine } from "../packages/shared/transcript/index.ts";

export const REMOTE_TOKEN_ENV = "SAMOGRAPH_CALL_TOKEN";
export const DEFAULT_REMOTE_INTERVAL_MS = 2000;
const DEFAULT_BACKOFF = { baseMs: 1000, capMs: 30_000 };

/** 401/403 from the site: the token is wrong for this call. Not retried. */
export class RemoteAuthError extends Error {
  constructor(
    public readonly status: number,
    callId: string,
  ) {
    super(
      `access denied (HTTP ${status}) for call ${callId}: the token is invalid, expired, revoked, or not for this call`,
    );
    this.name = "RemoteAuthError";
  }
}

interface WireLine {
  seq: number;
  ts: string;
  speaker: string | null;
  text: string;
  kind?: "chat" | "speech";
}
interface WireBody {
  status?: string | null;
  ended?: boolean;
  lines: WireLine[];
}

export interface PollOptions {
  baseUrl: string;
  callId: string;
  token: string;
  /** Resume cursor: only lines with `seq > sinceSeq` are emitted. Default 0. */
  sinceSeq?: number;
  intervalMs?: number;
  backoff?: { baseMs: number; capMs: number };
  onLine: (line: string, seq: number) => void | Promise<void>;
  /** Called after each emitted line, with the new cursor (persist it here). */
  onCursor?: (seq: number) => void | Promise<void>;
  log?: (msg: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

export interface PollResult {
  lastSeq: number;
  reason: "ended" | "aborted";
}

/**
 * Exponential backoff with "equal jitter": d = min(cap, base·2^attempt), then a
 * uniform delay in [d/2, d]. Never 0 (no hot loop), never above the cap.
 */
export function computeBackoffMs(attempt: number, random: () => number, baseMs: number, capMs: number): number {
  const d = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(d / 2 + random() * (d / 2));
}

/** Parse `Retry-After` (delta-seconds or HTTP date) → ms; fallback when absent/garbled. */
function retryAfterMs(h: string | null, fallbackMs: number): number {
  if (!h) return fallbackMs;
  const secs = Number(h.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : fallbackMs;
}

function redactor(token: string): (s: string) => string {
  return (s) => (token ? s.split(token).join("[REDACTED]") : s);
}

export async function pollRemoteTranscript(opts: PollOptions): Promise<PollResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = opts.random ?? Math.random;
  const interval = opts.intervalMs ?? DEFAULT_REMOTE_INTERVAL_MS;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const redact = redactor(opts.token);
  const rawLog = opts.log ?? ((m: string) => void process.stderr.write(m + "\n"));
  const log = (m: string) => rawLog(redact(m));
  const base = opts.baseUrl.replace(/\/+$/, "");
  // Token goes ONLY in the header; the URL carries nothing but the cursor.
  const headers = { authorization: `Bearer ${opts.token}`, accept: "application/json" };

  let last = opts.sinceSeq ?? 0;
  let failures = 0;

  while (!opts.signal?.aborted) {
    const url = `${base}/calls/${encodeURIComponent(opts.callId)}/transcript?since_seq=${last}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) break;
      const wait = computeBackoffMs(failures++, random, backoff.baseMs, backoff.capMs);
      log(`samograph watch --remote: network error (${(e as Error).message}); retrying in ${wait} ms from seq ${last}`);
      await sleep(wait);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new RemoteAuthError(res.status, opts.callId);
    }
    if (res.status === 429) {
      await res.body?.cancel();
      const wait = retryAfterMs(res.headers.get("retry-after"), interval);
      log(`samograph watch --remote: rate limited (HTTP 429); retrying in ${wait} ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      const wait = computeBackoffMs(failures++, random, backoff.baseMs, backoff.capMs);
      log(`samograph watch --remote: server error (HTTP ${res.status}); retrying in ${wait} ms from seq ${last}`);
      await sleep(wait);
      continue;
    }

    let body: WireBody;
    try {
      body = (await res.json()) as WireBody;
    } catch {
      const wait = computeBackoffMs(failures++, random, backoff.baseMs, backoff.capMs);
      log(`samograph watch --remote: malformed response; retrying in ${wait} ms from seq ${last}`);
      await sleep(wait);
      continue;
    }
    failures = 0;

    for (const l of body.lines ?? []) {
      if (!Number.isSafeInteger(l.seq) || l.seq <= last) continue; // exactly-once
      await opts.onLine(renderTranscriptLine(l), l.seq);
      last = l.seq;
      await opts.onCursor?.(last);
    }
    if (body.ended === true) return { lastSeq: last, reason: "ended" };
    if (opts.signal?.aborted) break;
    await sleep(interval);
  }
  return { lastSeq: last, reason: "aborted" };
}

// ── CLI wrapper: local transcript file + stdout + persisted cursor ──────────

interface CursorFile {
  call_id: string;
  since_seq: number;
}

function readCursor(path: string, callId: string): number {
  try {
    const c = JSON.parse(readFileSync(path, "utf-8")) as CursorFile;
    if (c.call_id === callId && Number.isSafeInteger(c.since_seq) && c.since_seq >= 0) return c.since_seq;
  } catch {
    /* missing or corrupt → start from 0 */
  }
  return 0;
}

function writeCursor(path: string, callId: string, seq: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ call_id: callId, since_seq: seq } satisfies CursorFile));
  renameSync(tmp, path); // atomic: a crash never leaves a half-written cursor
}

function sentinelTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export interface RunRemoteWatchOptions extends Omit<PollOptions, "onLine" | "onCursor" | "sinceSeq"> {
  /** Local transcript file lines are appended to; cursor lives at `<file>.cursor`. */
  transcriptFile: string;
  /** stdout writer (default process.stdout). */
  write?: (s: string) => void;
}

/**
 * Poll the site, append each new line to the local transcript file, print it,
 * and persist the cursor. A restarted process resumes from `<file>.cursor`. On
 * call end, appends the `SAMOGRAPH_CALL_ENDED` sentinel so a local `watch`
 * tailing the same file also exits.
 */
export async function runRemoteWatch(opts: RunRemoteWatchOptions): Promise<PollResult> {
  const tf = opts.transcriptFile;
  const cursorPath = `${tf}.cursor`;
  mkdirSync(dirname(tf), { recursive: true });
  if (!existsSync(tf)) writeFileSync(tf, "");
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const since = readCursor(cursorPath, opts.callId);

  const res = await pollRemoteTranscript({
    ...opts,
    sinceSeq: since,
    // The cursor is persisted after EVERY line (atomic rename), so a crash can
    // at worst repeat the one line that was appended but not yet checkpointed.
    onLine: (line) => {
      appendFileSync(tf, line + "\n");
      write(line + "\n");
    },
    onCursor: (seq) => writeCursor(cursorPath, opts.callId, seq),
  });
  if (res.reason === "ended") {
    appendFileSync(tf, `[${sentinelTs(new Date())}] SAMOGRAPH_CALL_ENDED\n`);
    (opts.log ?? ((m: string) => void process.stderr.write(m + "\n")))(
      `samograph watch --remote: call ${opts.callId} ended (last seq ${res.lastSeq})`,
    );
  }
  return res;
}

/** Token source: `--token-file` (preferred) or `$SAMOGRAPH_CALL_TOKEN`. Never argv. */
export function resolveRemoteToken(o: { env?: Record<string, string | undefined>; tokenFile?: string | null }): string {
  if (o.tokenFile) {
    const t = readFileSync(o.tokenFile, "utf-8").trim();
    if (t) return t;
  }
  const t = (o.env ?? process.env)[REMOTE_TOKEN_ENV]?.trim();
  if (t) return t;
  throw new Error(`no call token: set ${REMOTE_TOKEN_ENV} or pass --token-file FILE`);
}
