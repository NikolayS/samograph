import {
  existsSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  defaultTranscriptFile,
  samographDir,
  stateFile,
} from "./config.ts";
import { loadState } from "./state.ts";

export const SENTINEL_RE =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] SAMOGRAPH_CALL_ENDED$/;

function expanduser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveTranscriptFile(transcriptDir?: string | null): string {
  const d = resolveTranscriptDir(transcriptDir);
  return join(d, "transcript.txt");
}

function resolveTranscriptDir(transcriptDir?: string | null): string {
  let d: string;
  if (transcriptDir) {
    d = expanduser(transcriptDir);
  } else {
    d = samographDir();
  }
  mkdirSync(d, { recursive: true });
  return d;
}

function timestampPrefixUtc(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
  ].join("") + "_" + [
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
}

export function resolveNewTranscriptFile(
  transcriptDir?: string | null,
  now: Date = new Date(),
): string {
  const d = resolveTranscriptDir(transcriptDir);
  const prefix = timestampPrefixUtc(now);
  let candidate = join(d, `${prefix}_transcript.txt`);
  for (let i = 2; existsSync(candidate); i += 1) {
    candidate = join(d, `${prefix}_${i}_transcript.txt`);
  }
  return candidate;
}

// Transcript formatting lives once in the shared package so the CLI and the
// hosted ingest service stay byte-identical (SPEC §5.4, #39). Re-exported here
// under the CLI's historical name so existing callers are unchanged.
export {
  sanitizeTranscriptField,
  normalizeTranscriptLine as formatTranscriptLine,
  // The CLI/agent entry point that carries `kind` (speech | chat, #188) and
  // renders incoming meeting chat as `[ts] <name> (chat): <text>`.
  normalizeTranscriptEvent,
  CHAT_LINE_MARKER,
  CHAT_TRANSCRIPT_EVENT,
  type NormalizedTranscriptLine,
  type TranscriptLineKind,
} from "../packages/shared/transcript/index.ts";

export function transcriptPathFromState(): string {
  const state = loadState();
  const tf = state.transcript_file;
  if (typeof tf === "string" && tf) {
    return tf;
  }
  return defaultTranscriptFile();
}

export function printLocalTranscript(path?: string): void {
  const tf = path ?? transcriptPathFromState();
  if (existsSync(tf)) {
    const lines = localTranscriptLines(tf);
    if (lines.length) {
      const tail = lines.slice(-20);
      const base = tf.split("/").pop() ?? tf;
      process.stdout.write(
        `\n--- last ${Math.min(20, lines.length)} lines from ${base} ---\n`,
      );
      for (const line of tail) {
        process.stdout.write(line + "\n");
      }
    } else {
      process.stdout.write(
        `${tf} is empty -- call may not have started yet.\n`,
      );
    }
  } else {
    process.stdout.write(`Transcript not found at ${tf}\n`);
  }
}

export function localTranscriptLines(path?: string): string[] {
  const tf = path ?? transcriptPathFromState();
  if (!existsSync(tf)) {
    return [];
  }
  return readFileSync(tf, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !SENTINEL_RE.test(l));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WatchOpts {
  pollMs?: number;
  /** How many poll iterations between state.json existence checks. */
  stateGoneCheckEvery?: number;
  /** Max iterations to wait for the transcript file to appear (each pollMs*5 in Python: 0.5s). */
  appearWaitMs?: number;
  /** Replay the existing transcript before tailing live lines. */
  fromStart?: boolean;
}

/**
 * Stream transcript lines to a callback as they arrive.
 * Exits when SAMOGRAPH_CALL_ENDED sentinel is seen or when state.json disappears.
 */
export async function streamTranscriptLines(
  onLine: (line: string) => void | Promise<void>,
  opts: WatchOpts = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 100;
  const stateGoneCheckEvery = opts.stateGoneCheckEvery ?? 20;
  const appearWaitMs = opts.appearWaitMs ?? 30000;

  const tf = transcriptPathFromState();

  // Wait for transcript file to appear (may not exist yet right after join)
  let waited = 0;
  while (!existsSync(tf)) {
    mkdirSync(join(tf, ".."), { recursive: true });
    await sleep(500);
    waited += 500;
    if (waited >= appearWaitMs) {
      writeFileSync(tf, "");
      break;
    }
  }

  // If the call already ended before watch started, exit immediately.
  if (!existsSync(stateFile())) {
    process.stderr.write("No active session. Run 'samograph join' first.\n");
    return;
  }
  for (const existing of readFileSync(tf, "utf-8").split(/\r?\n/)) {
    if (SENTINEL_RE.test(existing.replace(/\n$/, ""))) {
      return;
    }
  }

  if (opts.fromStart === true) {
    for (const existing of readFileSync(tf, "utf-8").split(/\r?\n/)) {
      if (!existing) continue;
      if (SENTINEL_RE.test(existing.replace(/\r$/, ""))) {
        return;
      }
      await onLine(existing);
    }
  }

  // Tail the file from current end unless fromStart replayed through current contents.
  const fd = openSync(tf, "r");
  try {
    let pos = Bun.file(tf).size;
    let pollCounter = 0;
    let buffer = "";
    const chunk = Buffer.alloc(64 * 1024);
    // One decoder for the whole tail session so a multibyte char split across
    // a 64KB chunk boundary — or across two separate polls — is reassembled,
    // not corrupted to U+FFFD. This is a multilingual transcript tool.
    let decoder = new StringDecoder("utf-8");

    while (true) {
      const size = Bun.file(tf).size;
      if (size < pos) {
        // File was truncated/rotated — re-sync
        // from the start. Reset the read position, the line buffer, and the
        // decoder (any partial-byte state belongs to the old file contents).
        pos = 0;
        buffer = "";
        decoder = new StringDecoder("utf-8");
      }
      if (size > pos) {
        const toRead = size - pos;
        let remaining = toRead;
        let offset = pos;
        let data = "";
        while (remaining > 0) {
          const n = readSync(
            fd,
            chunk,
            0,
            Math.min(chunk.length, remaining),
            offset,
          );
          if (n <= 0) break;
          data += decoder.write(chunk.subarray(0, n));
          offset += n;
          remaining -= n;
        }
        pos = offset;
        buffer += data;

        // Process complete lines.
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (SENTINEL_RE.test(line.replace(/\r$/, ""))) {
            return;
          }
          await onLine(line);
        }
      } else {
        pollCounter += 1;
        await sleep(pollMs);
        if (
          pollCounter % stateGoneCheckEvery === 0 &&
          !existsSync(stateFile())
        ) {
          return;
        }
      }
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Stream transcript lines to stdout as they arrive.
 * Exits when SAMOGRAPH_CALL_ENDED sentinel is seen or when state.json disappears.
 */
export async function watch(opts: WatchOpts = {}): Promise<void> {
  return streamTranscriptLines((line) => {
    process.stdout.write(line + "\n");
  }, opts);
}

/**
 * Result of reading the transcript after an opaque cursor (#since).
 *
 * The cursor is a byte offset into the append-only transcript file, always
 * positioned just after a newline (or 0). Callers must treat it as opaque and
 * only pass back a value previously returned here.
 */
export interface TranscriptSinceResult {
  /** Complete lines after the cursor (no trailing newline, CR stripped). */
  lines: string[];
  /** Cursor to pass to the next call. */
  cursor: number;
  /** True when the given cursor was invalid for this file and reading restarted at 0. */
  reset: boolean;
  /** Human-readable reason for the reset, if any. */
  warning?: string;
  /** True when the SAMOGRAPH_CALL_ENDED sentinel was seen after the cursor. */
  ended: boolean;
  /** True when the transcript file does not exist (yet). */
  missing: boolean;
}

/**
 * Read complete lines after `cursor` (a byte offset) from an append-only
 * transcript file. Why bytes and not timestamps: webhook lines can be appended
 * slightly out of timestamp order, and the end sentinel uses local time, so a
 * timestamp filter would drop or repeat lines. A byte offset in an append-only
 * file is exact.
 *
 * - A trailing partial line (no "\n" yet) is never returned; the cursor stays
 *   before it, so the next call returns it once it is complete.
 * - A cursor past EOF, or one not on a line boundary, means the file was
 *   truncated/replaced: restart at 0 and report `reset` with a warning.
 * - Blank lines are skipped; the SAMOGRAPH_CALL_ENDED sentinel is not returned
 *   as a line but sets `ended`.
 * - `limit` caps returned lines; the cursor then points just after the last
 *   returned line.
 * - Reading stops at the sentinel and the cursor stays before it, so `ended`
 *   is reported again on every later call with that cursor.
 */
export function readTranscriptSince(
  path: string,
  cursor: number,
  limit?: number,
): TranscriptSinceResult {
  if (!existsSync(path)) {
    return {
      lines: [],
      cursor: 0,
      reset: cursor > 0,
      warning: cursor > 0 ? `transcript not found at ${path}; cursor reset to 0` : undefined,
      ended: false,
      missing: true,
    };
  }
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let start = cursor;
    let reset = false;
    let warning: string | undefined;
    if (start > size) {
      reset = true;
      warning = `cursor ${cursor} is past end of transcript (${size} bytes; file truncated or replaced); restarting from 0`;
      start = 0;
    } else if (start > 0) {
      const prev = Buffer.alloc(1);
      readSync(fd, prev, 0, 1, start - 1);
      if (prev[0] !== 0x0a) {
        reset = true;
        warning = `cursor ${cursor} is not at a line boundary (file replaced?); restarting from 0`;
        start = 0;
      }
    }

    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const data = buf.subarray(0, got);

    const lines: string[] = [];
    let ended = false;
    let pos = 0; // offset within data just after the last consumed newline
    while (true) {
      // 0x0a never occurs inside a UTF-8 multibyte sequence, so splitting on
      // raw bytes is safe and keeps offsets exact.
      const nl = data.indexOf(0x0a, pos);
      if (nl === -1) break;
      const line = data.subarray(pos, nl).toString("utf-8").replace(/\r$/, "");
      if (SENTINEL_RE.test(line)) {
        // Stop here (like `watch`) and leave the cursor before the sentinel,
        // so every later call with this cursor also reports `ended`.
        ended = true;
        break;
      }
      if (line.trim()) {
        if (limit !== undefined && lines.length >= limit) break;
        lines.push(line);
      }
      pos = nl + 1;
    }
    return { lines, cursor: start + pos, reset, warning, ended, missing: false };
  } finally {
    closeSync(fd);
  }
}

/**
 * A `transcript --since` cursor. Printed forms:
 *   b:<offset>          byte offset in the transcript file (file path)
 *   s:<seq>:<offset>    line seq in the live server log, plus the byte offset
 *                       of the same point in the file (used if the server is
 *                       gone, e.g. after `leave`)
 * Input also accepts `0` (from the start; prefers the server) and a bare
 * integer (byte offset).
 */
export type SinceCursor =
  | { kind: "start" }
  | { kind: "byte"; offset: number }
  | { kind: "seq"; seq: number; offset: number };

export function parseSinceCursor(raw: string): SinceCursor | null {
  const int = (s: string): number | null => {
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  };
  if (raw === "0") return { kind: "start" };
  let m = raw.match(/^(?:b:)?(\d+)$/);
  if (m) {
    const offset = int(m[1]!);
    return offset === null ? null : { kind: "byte", offset };
  }
  m = raw.match(/^s:(\d+):(\d+)$/);
  if (m) {
    const seq = int(m[1]!);
    const offset = int(m[2]!);
    return seq === null || offset === null ? null : { kind: "seq", seq, offset };
  }
  return null;
}

export interface WaitSinceOpts {
  /** Max seconds to wait for at least one new line. */
  waitSeconds: number;
  limit?: number;
  pollMs?: number;
}

/**
 * Like readTranscriptSince, but long-polls until at least one new complete
 * line exists past the cursor, the call has ended, or the timeout elapses.
 */
export async function waitTranscriptSince(
  path: string,
  cursor: number,
  opts: WaitSinceOpts,
): Promise<TranscriptSinceResult> {
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let res = readTranscriptSince(path, cursor, opts.limit);
  // Only warn about a reset once; subsequent polls continue from the reset cursor.
  const first = res;
  while (!res.lines.length && !res.ended && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    res = readTranscriptSince(path, res.cursor, opts.limit);
  }
  if (first.reset && !res.reset) {
    res = { ...res, reset: true, warning: first.warning };
  }
  return res;
}
