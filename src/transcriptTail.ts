import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { CHAT_LINE_MARKER } from "./transcript.ts";

/** `[YYYY-MM-DD HH:MM:SS] Speaker: text` (Speaker may end with " (chat)"). */
export const TRANSCRIPT_LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.+?): (.*)$/;

export interface TranscriptEntry {
  /** UTC epoch ms parsed from the line timestamp (NaN if unparseable). */
  ts: number;
  /** Speaker name without the chat marker. */
  speaker: string;
  text: string;
  source: "voice" | "chat";
  /** True for SAMOGRAPH-WARNING lines and sentinels. */
  system: boolean;
  raw: string;
}

export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const m = line.trim().match(TRANSCRIPT_LINE_RE);
  if (!m) return null;
  let speaker = m[2]!;
  let source: "voice" | "chat" = "voice";
  if (speaker.endsWith(CHAT_LINE_MARKER)) {
    speaker = speaker.slice(0, -CHAT_LINE_MARKER.length);
    source = "chat";
  }
  return {
    ts: Date.parse(m[1]!.replace(" ", "T") + "Z"),
    speaker,
    text: m[3]!,
    source,
    system: speaker.startsWith("SAMOGRAPH"),
    raw: line,
  };
}

/**
 * Incremental reader of the live transcript file: starts at the current end
 * of the file and returns only complete lines appended since the last read.
 * Used by `say` (barge-in) and `ask` (waiting for an answer).
 */
export class TranscriptTail {
  private offset: number;
  private partial = "";

  constructor(private path: string) {
    this.offset = existsSync(path) ? statSync(path).size : 0;
  }

  /** New complete lines since the previous call (raw, without newlines). */
  readLines(): string[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) {
      // File was truncated/replaced: start over from its beginning.
      this.offset = 0;
      this.partial = "";
    }
    if (size <= this.offset) return [];
    const fd = openSync(this.path, "r");
    let text = "";
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      text = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    return lines;
  }

  /** New parsed entries since the previous call. */
  readEntries(): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    for (const line of this.readLines()) {
      const e = parseTranscriptLine(line);
      if (e) out.push(e);
    }
    return out;
  }
}
