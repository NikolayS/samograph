import { botIdFromArgsOrState } from "../state.ts";
import { printLocalTranscript } from "../transcript.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient, type FetchFn } from "../recall.ts";

export interface TranscriptDeps {
  recall?: RecallClient;
  fetchFn?: FetchFn;
}

export async function cmdTranscript(
  args: ParsedArgs,
  deps: TranscriptDeps = {},
): Promise<void> {
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
    printLocalTranscript();
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
    for (const entry of data) {
      const words = (entry.words ?? []).map((w) => w.text ?? "").join(" ");
      const speaker = entry.speaker ?? "?";
      const start = entry.words?.[0]?.start_time ?? 0;
      process.stdout.write(`[${start.toFixed(1)}s] ${speaker}: ${words}\n`);
    }
  } else {
    process.stdout.write(`Transcript status: ${statusCode}\n`);
    printLocalTranscript();
  }
}
