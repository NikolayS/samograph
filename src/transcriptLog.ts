import { appendFileSync, existsSync, readFileSync } from "node:fs";

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
  private pending = Buffer.alloc(0);

  constructor(readonly path: string) {
    // Rebuild sequence numbers and byte boundaries from durable history so
    // a cursor issued before restart still refers to the same line.
    if (existsSync(path)) {
      const data = readFileSync(path);
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        this.offset = end + 1;
        this.record(data.subarray(start, end).toString("utf-8"));
        start = end + 1;
      }
      // An interrupted write is not a complete line: don't move a caller's
      // fallback cursor past it. The next append will finish this line.
      this.pending = Buffer.from(data.subarray(start));
      this.offset = data.length;
    }
  }

  get lastSeq(): number {
    return this.entries.length;
  }

  /** Append one line to the file and the log, then wake every waiter. */
  append(line: string): TranscriptLogEntry {
    appendFileSync(this.path, line + "\n");
    this.offset += Buffer.byteLength(line + "\n");
    const entry = this.record(Buffer.concat([this.pending, Buffer.from(line)]).toString("utf-8"));
    this.pending = Buffer.alloc(0);
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
    return entry;
  }

  private record(line: string): TranscriptLogEntry {
    const entry: TranscriptLogEntry = {
      seq: this.entries.length + 1,
      ...parseTranscriptLine(line),
      line,
      offset: this.offset,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Lines with seq > since (at most `limit`). */
  since(since: number, limit?: number): TranscriptLogPage {
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
    };
  }

  /** Long-poll: resolve with lines after `since`, or empty after `waitMs`. */
  async wait(since: number, waitMs: number, limit?: number): Promise<TranscriptLogPage> {
    const page = this.since(since, limit);
    if (page.lines.length || waitMs <= 0) return page;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, waitMs);
      this.waiters.add(wake);
    });
    const after = this.since(page.next, limit);
    return { ...after, reset: page.reset || after.reset };
  }

  /** Call onEntry for every entry after `since`, now and as they arrive. Returns an unsubscribe. */
  subscribe(onEntry: (e: TranscriptLogEntry) => void, since: number): () => void {
    let cursor = since > this.entries.length ? 0 : since;
    let active = true;
    const pump = () => {
      if (!active) return;
      while (cursor < this.entries.length) {
        onEntry(this.entries[cursor]!);
        cursor += 1;
      }
      this.waiters.add(pump);
    };
    pump();
    return () => {
      active = false;
      this.waiters.delete(pump);
    };
  }
}
