import {
  existsSync,
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
  samoagentDir,
  stateFile,
} from "./config.ts";
import { loadState } from "./state.ts";

export const SENTINEL_RE =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] SAMOAGENT_CALL_ENDED$/;

function expanduser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveTranscriptFile(transcriptDir?: string | null): string {
  let d: string;
  if (transcriptDir) {
    d = expanduser(transcriptDir);
  } else {
    d = samoagentDir();
  }
  mkdirSync(d, { recursive: true });
  return join(d, "transcript.txt");
}

interface WordEntry {
  text?: string;
  start_timestamp?: { absolute?: string };
}

interface TranscriptPayload {
  event?: string;
  data?: {
    data?: {
      participant?: { name?: string };
      words?: WordEntry[];
    };
  };
}

export function sanitizeTranscriptField(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Replicate the webhook transcript formatting logic.
 * Returns the `[ts] speaker: text` line, or null if the payload is not a
 * transcript.data event with words.
 */
export function formatTranscriptLine(payload: unknown): string | null {
  const p = (payload ?? {}) as TranscriptPayload;
  if (p.event !== "transcript.data") {
    return null;
  }
  const inner = p.data?.data ?? {};
  const words = inner.words ?? [];
  if (!words.length) {
    return null;
  }
  const text = sanitizeTranscriptField(words.map((w) => w.text ?? "").join(" "));
  const speaker = sanitizeTranscriptField(inner.participant?.name ?? "") || "?";
  const absolute = words[0]?.start_timestamp?.absolute ?? "";
  const ts = absolute.slice(0, 19).replace("T", " ");
  return `[${ts}] ${speaker}: ${text}`;
}

function transcriptPathFromState(): string {
  const state = loadState();
  const tf = state.transcript_file;
  if (typeof tf === "string" && tf) {
    return tf;
  }
  return defaultTranscriptFile();
}

export function printLocalTranscript(): void {
  const tf = transcriptPathFromState();
  if (existsSync(tf)) {
    const lines = readFileSync(tf, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !SENTINEL_RE.test(l));
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WatchOpts {
  pollMs?: number;
  /** How many poll iterations between state.json existence checks. */
  stateGoneCheckEvery?: number;
  /** Max iterations to wait for the transcript file to appear (each pollMs*5 in Python: 0.5s). */
  appearWaitMs?: number;
}

/**
 * Stream transcript lines to stdout as they arrive.
 * Exits when SAMOAGENT_CALL_ENDED sentinel is seen or when state.json disappears.
 */
export async function watch(opts: WatchOpts = {}): Promise<void> {
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
    return;
  }
  for (const existing of readFileSync(tf, "utf-8").split(/\r?\n/)) {
    if (SENTINEL_RE.test(existing.replace(/\n$/, ""))) {
      return;
    }
  }

  // Tail the file from current end.
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
        // File was truncated/rotated (e.g. a new join cleared it) — re-sync
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
          process.stdout.write(line + "\n");
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
