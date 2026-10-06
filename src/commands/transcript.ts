import { botIdFromArgsOrState, loadState } from "../state.ts";
import {
  localTranscriptLines,
  parseSinceCursor,
  printLocalTranscript,
  readTranscriptSince,
  transcriptPathFromState,
  waitTranscriptSince,
} from "../transcript.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient, type FetchFn } from "../recall.ts";

export interface TranscriptDeps {
  recall?: RecallClient;
  fetchFn?: FetchFn;
}

function printLinesWithCursor(lines: string[], args: ParsedArgs): void {
  const cursor = args.transcript_cursor ?? 0;
  const limit = args.transcript_limit;
  const end = limit === undefined ? lines.length : Math.min(lines.length, cursor + limit);
  for (const line of lines.slice(cursor, end)) {
    process.stdout.write(line + "\n");
  }
  if (args.transcript_cursor !== undefined || limit !== undefined) {
    process.stdout.write(`Next cursor: ${end}\n`);
  }
}

function printLocalTranscriptChunk(args: ParsedArgs): void {
  const lines = localTranscriptLines(args.transcript_file);
  if (lines.length) {
    printLinesWithCursor(lines, args);
  } else {
    printLocalTranscript(args.transcript_file);
  }
}

interface SinceOutput {
  lines: string[];
  cursor: string;
  ended: boolean;
  reset: boolean;
  warning?: string;
}

interface ServerPage {
  lines: Array<{ line: string }>;
  next: number;
  offset: number;
  reset: boolean;
}

/** Max seconds per server long-poll request (the server caps at 60). */
const SERVER_WAIT_CHUNK_SECONDS = 60;

/**
 * Low-latency path: long-poll the active call's local server. Returns null
 * when no server is configured or reachable, so the caller falls back to the
 * transcript file.
 */
async function sinceViaServer(
  seq: number,
  args: ParsedArgs,
  fetchFn: FetchFn,
): Promise<SinceOutput | null> {
  let state: Record<string, unknown>;
  try {
    state = loadState();
  } catch {
    return null;
  }
  const url = state.local_transcript_url;
  const token = state.transcript_token;
  if (typeof url !== "string" || !url || typeof token !== "string" || !token) return null;

  const deadline = Date.now() + (args.transcript_wait ?? 0) * 1000;
  let since = seq;
  let reset = false;
  while (true) {
    const remaining = Math.max(0, (deadline - Date.now()) / 1000);
    const wait = Math.min(remaining, SERVER_WAIT_CHUNK_SECONDS);
    const q = new URL(url);
    q.searchParams.set("since", String(since));
    q.searchParams.set("wait", wait.toFixed(3));
    if (args.transcript_limit !== undefined) q.searchParams.set("limit", String(args.transcript_limit));
    let page: ServerPage;
    try {
      const r = await fetchFn(q.toString(), {
        headers: { "X-Samograph-Transcript-Token": token },
        signal: AbortSignal.timeout((wait + 10) * 1000),
      });
      if (!r.ok) return null;
      page = (await r.json()) as ServerPage;
    } catch {
      // Server gone (call ended / leave) or not running: use the file.
      return null;
    }
    reset ||= page.reset;
    since = page.next;
    if (page.lines.length || Date.now() >= deadline) {
      return {
        lines: page.lines.map((l) => l.line),
        cursor: `s:${page.next}:${page.offset}`,
        ended: false,
        reset,
        warning: reset ? `cursor s:${seq} is ahead of the live server log (server restarted?); restarting from its first line` : undefined,
      };
    }
  }
}

async function sinceViaFile(offset: number, args: ParsedArgs): Promise<SinceOutput> {
  const path = args.transcript_file ?? transcriptPathFromState();
  const res = args.transcript_wait !== undefined
    ? await waitTranscriptSince(path, offset, {
        waitSeconds: args.transcript_wait,
        limit: args.transcript_limit,
      })
    : readTranscriptSince(path, offset, args.transcript_limit);
  let warning = res.warning;
  if (res.missing && !warning) warning = `transcript not found at ${path}`;
  return { lines: res.lines, cursor: `b:${res.cursor}`, ended: res.ended, reset: res.reset, warning };
}

/**
 * `transcript --since CURSOR`: print only lines added after CURSOR, then the
 * next cursor on stderr (or one JSON object with --json). Uses the active
 * call's local server long-poll when reachable (`s:` cursors), otherwise the
 * append-only transcript file (`b:` byte cursors).
 */
async function printTranscriptSince(args: ParsedArgs, fetchFn: FetchFn): Promise<void> {
  const cursor = parseSinceCursor(args.transcript_since ?? "0") ?? { kind: "start" as const };
  let out: SinceOutput | null = null;
  if (!args.transcript_file && cursor.kind !== "byte") {
    out = await sinceViaServer(cursor.kind === "seq" ? cursor.seq : 0, args, fetchFn);
  }
  if (out === null) {
    out = await sinceViaFile(cursor.kind === "start" ? 0 : cursor.offset, args);
  }

  if (out.warning) {
    process.stderr.write(`SAMOGRAPH-WARNING: ${out.warning}\n`);
  }
  if (args.transcript_json) {
    process.stdout.write(JSON.stringify({
      lines: out.lines,
      cursor: out.cursor,
      ended: out.ended,
      reset: out.reset,
    }) + "\n");
    return;
  }
  for (const line of out.lines) {
    process.stdout.write(line + "\n");
  }
  if (out.ended) {
    process.stderr.write("SAMOGRAPH-CALL-ENDED\n");
  }
  process.stderr.write(`SAMOGRAPH-CURSOR: ${out.cursor}\n`);
}

export async function cmdTranscript(
  args: ParsedArgs,
  deps: TranscriptDeps = {},
): Promise<void> {
  if (args.transcript_since !== undefined) {
    await printTranscriptSince(args, deps.fetchFn ?? fetch);
    return;
  }
  if (args.transcript_local === true || args.transcript_file) {
    printLocalTranscriptChunk(args);
    return;
  }

  const recall = deps.recall ?? makeRecallClient();
  const fetchFn = deps.fetchFn ?? fetch;
  const bid = botIdFromArgsOrState(args.bot_id);
  const bot = (await recall.getBot(bid)) as {
    recordings?: Array<{
      media_shortcuts?: {
        transcript?: {
          status?: { code?: string };
          data?: { download_url?: string };
        };
      };
    }>;
  };
  const recordings = bot.recordings ?? [];
  if (!recordings.length) {
    process.stdout.write("No recordings yet.\n");
    printLocalTranscriptChunk(args);
    return;
  }

  const media = recordings[0]!.media_shortcuts?.transcript ?? {};
  const statusCode = media.status?.code ?? "?";
  const downloadUrl = media.data?.download_url;

  if (downloadUrl) {
    const r = await fetchFn(downloadUrl, { signal: AbortSignal.timeout(30000) });
    const data = (await r.json()) as Array<{
      words?: Array<{ text?: string; start_time?: number }>;
      speaker?: string;
    }>;
    const lines = data.map((entry) => {
      const words = (entry.words ?? []).map((w) => w.text ?? "").join(" ");
      const speaker = entry.speaker ?? "?";
      const start = entry.words?.[0]?.start_time ?? 0;
      return `[${start.toFixed(1)}s] ${speaker}: ${words}`;
    });
    printLinesWithCursor(lines, args);
  } else {
    process.stdout.write(`Transcript status: ${statusCode}\n`);
    printLocalTranscriptChunk(args);
  }
}
