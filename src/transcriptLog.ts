import { appendFileSync, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { SENTINEL_RE } from "./transcript.ts";

/**
 * One transcript line as served by `GET /transcript` on the local callback
 * server. `seq` is 1-based and strictly increasing within the
 * transcript file (one call), including after a server restart.
 */
export interface TranscriptLogEntry {
  seq: number;
  /** Timestamp text from the line prefix, e.g. "2026-10-06 16:46:18" ("" if none). */
  ts: string;
  /** Speaker (or marker such as "SAMOGRAPH-WARNING"; "" if none). */
  speaker: string;
  text: string;
  /** The full line exactly as written to the transcript file (no newline). */
  line: string;
  /** Byte offset in the transcript file just after this line. */
  offset: number;
}

const LINE_RE = /^\[([^\]]*)\] ([^:]*?): (.*)$/s;
const TS_ONLY_RE = /^\[([^\]]*)\] ?(.*)$/s;

export function parseTranscriptLine(line: string): { ts: string; speaker: string; text: string } {
  const m = line.match(LINE_RE);
  if (m) return { ts: m[1]!, speaker: m[2]!, text: m[3]! };
  const t = line.match(TS_ONLY_RE);
  if (t) return { ts: t[1]!, speaker: "", text: t[2]! };
  return { ts: "", speaker: "", text: line };
}

export interface TranscriptLogPage {
  lines: TranscriptLogEntry[];
  /** Pass back as `since` to get only later lines. */
  next: number;
  /** Byte offset in the transcript file after the last returned line. */
  offset: number;
  /** True when `since` was ahead of this log (server restarted): read from 1. */
  reset: boolean;
  ended: boolean;
}

/**
 * In-memory, monotonically numbered log of the complete lines in the transcript
 * file. It is the low-latency path for agents: a
 * long-poll waiter is woken the moment a line is appended, with no file
 * polling. The file stays the source of truth; this log mirrors it.
 */
export class TranscriptLog {
  private entries: TranscriptLogEntry[] = [];
  private waiters = new Set<() => void>();
  private offset = 0;
  private endedSeq: number | undefined;
  private pending = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private fileIdentity = "";
  private fileVersion = "";

  constructor(readonly path: string) {
    this.sync();
  }

  /** Pick up durable lines written by another process (notably `leave`). */
  private sync(): void {
    let fd: number | undefined;
    try {
      const versionOf = (stat: NonNullable<ReturnType<typeof statSync>>) =>
        `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const stat = statSync(this.path);
      if (versionOf(stat) === this.fileVersion) return;
      fd = openSync(this.path, "r");
      const current = fstatSync(fd);
      const identity = `${current.dev}:${current.ino}`;
      const readRange = (start: number, length: number): Buffer => {
        const buffer = Buffer.alloc(length);
        let bytes = 0;
        while (bytes < length) {
          const count = readSync(fd!, buffer, bytes, length - bytes, start + bytes);
          if (!count) break;
          bytes += count;
        }
        return buffer.subarray(0, bytes);
      };
      // Rotation, shrink, or a changed durable tail invalidates the mirror.
      // Normal appends read only a bounded tail plus the newly appended bytes.
      const tail = current.size >= this.offset
        ? readRange(this.offset - this.tail.length, this.tail.length) : Buffer.alloc(0);
      if (identity !== this.fileIdentity || current.size < this.offset || !tail.equals(this.tail)) {
        this.entries = [];
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        this.endedSeq = undefined;
      }
      const startOffset = this.offset - this.pending.length;
      const data = Buffer.concat([this.pending, readRange(this.offset, Math.max(0, current.size - this.offset))]);
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        this.offset = startOffset + end + 1;
        this.record(data.subarray(start, end).toString("utf-8"));
        start = end + 1;
      }
      this.pending = Buffer.from(data.subarray(start));
      this.offset = startOffset + data.length;
      this.tail = readRange(Math.max(0, this.offset - 64), Math.min(64, this.offset));
      this.fileIdentity = identity;
      this.fileVersion = versionOf(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.fileVersion = "";
        return;
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  get lastSeq(): number {
    return this.entries.length;
  }

  /** Append one line to the file and the log, then wake every waiter. */
  append(line: string): void {
    this.sync();
    if (this.pending.length) {
      // append() receives a new logical line, not continuation bytes. Preserve
      // a crash fragment separately rather than merging speakers/warnings.
      appendFileSync(this.path, "\n");
      this.sync();
    }
    appendFileSync(this.path, line + "\n");
    // Another process may append between sync() and our write. Read the
    // actual byte stream back rather than inventing offsets/order.
    this.sync();
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  private record(line: string): TranscriptLogEntry {
    const entry: TranscriptLogEntry = {
      seq: this.entries.length + 1,
      ...parseTranscriptLine(line),
      line,
      offset: this.offset,
    };
    this.entries.push(entry);
    if (SENTINEL_RE.test(line)) this.endedSeq ??= entry.seq;
    return entry;
  }

  /** Lines with seq > since (at most `limit`). */
  since(since: number, limit?: number): TranscriptLogPage {
    this.sync();
    let from = since;
    let reset = false;
    if (from > this.entries.length) {
      from = 0;
      reset = true;
    }
    const end = limit === undefined ? this.entries.length : Math.min(this.entries.length, from + limit);
    const lines = this.entries.slice(from, end);
    const next = from + lines.length;
    return {
      lines,
      next,
      offset: next > 0 ? this.entries[next - 1]!.offset : 0,
      reset,
      ended: this.endedSeq !== undefined && next >= this.endedSeq,
    };
  }

  /** Long-poll: resolve with lines after `since`, or empty after `waitMs`. */
  async wait(since: number, waitMs: number, limit?: number): Promise<TranscriptLogPage> {
    const deadline = Date.now() + waitMs;
    let page = this.since(since, limit);
    let reset = page.reset;
    while (!page.lines.length && !page.ended && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        // In-process appends wake immediately; poll only to discover external
        // writes such as the end sentinel, without waiting out a 60s request.
        const timer = setTimeout(wake, Math.min(100, deadline - Date.now()));
        this.waiters.add(wake);
      });
      page = this.since(page.next, limit);
      reset ||= page.reset;
    }
    return { ...page, reset };
  }

  /** Call onEntry for every entry after `since`, now and as they arrive. Returns an unsubscribe. */
  subscribe(
    onEntry: (e: TranscriptLogEntry) => void,
    since: number,
    onError: (error: unknown) => void = (error) => { throw error; },
  ): () => void {
    this.sync();
    let cursor = since > this.entries.length ? 0 : since;
    let active = true;
    const pump = () => {
      if (!active) return;
      this.sync();
      if (cursor > this.entries.length) cursor = 0;
      while (cursor < this.entries.length) {
        onEntry(this.entries[cursor]!);
        cursor += 1;
      }
      this.waiters.add(pump);
    };
    pump();
    const timer = setInterval(() => {
      try { pump(); } catch (error) { stop(); onError(error); }
    }, 100);
    const stop = () => {
      active = false;
      clearInterval(timer);
      this.waiters.delete(pump);
    };
    return stop;
  }
}
