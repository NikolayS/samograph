import { botIdFromArgsOrState } from "../state.ts";
import { localTranscriptLines, printLocalTranscript } from "../transcript.ts";
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

export async function cmdTranscript(
  args: ParsedArgs,
  deps: TranscriptDeps = {},
): Promise<void> {
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
