import { existsSync, readFileSync, statSync } from "node:fs";
import { defaultTranscriptFile } from "../config.ts";
import type { FrameInventory, VideoFrameMetadata } from "../frameStore.ts";
import { loadState, botIdFromArgsOrState } from "../state.ts";
import { SENTINEL_RE } from "../transcript.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";

export interface StatusDeps {
  recall?: RecallClient;
  fetchFn?: typeof fetch;
}

export async function cmdStatus(
  args: ParsedArgs,
  deps: StatusDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const fetchFn = deps.fetchFn ?? fetch;
  const bid = botIdFromArgsOrState(args.bot_id);
  const bot = (await recall.getBot(bid)) as {
    status_changes?: Array<{ code?: string }>;
    bot_name?: string;
  };
  const changes = bot.status_changes ?? [];
  const status = changes.length
    ? (changes[changes.length - 1]!.code ?? "unknown")
    : "joining";
  const name = bot.bot_name ?? "?";
  process.stdout.write(`Bot:    ${bid}\n`);
  process.stdout.write(`Name:   ${name}\n`);
  process.stdout.write(`Status: ${status}\n`);

  const state = loadState();
  const tf =
    typeof state.transcript_file === "string"
      ? state.transcript_file
      : defaultTranscriptFile();
  if (existsSync(tf)) {
    const lines = readFileSync(tf, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !SENTINEL_RE.test(l));
    process.stdout.write(`Transcript lines so far: ${lines.length}\n`);
    if (lines.length) {
      process.stdout.write(
        `Last transcript at: ${statSync(tf).mtime.toISOString()}\n`,
      );
      process.stdout.write(
        `Last transcript line: ${lines[lines.length - 1]}\n`,
      );
    } else {
      process.stdout.write("Last transcript line: none yet\n");
    }
    process.stdout.write(`Transcript file: ${tf}\n`);
  }

  const frameMetadataUrl = state.local_frame_metadata_url;
  if (typeof frameMetadataUrl === "string" && frameMetadataUrl) {
    const headers: Record<string, string> = {};
    if (typeof state.frame_token === "string" && state.frame_token) {
      headers["X-Samocall-Frame-Token"] = state.frame_token;
    }
    try {
      const resp = await fetchFn(frameMetadataUrl, { headers });
      if (resp.status === 404) {
        process.stdout.write("Last frame: none yet\n");
      } else if (resp.ok) {
        const metadata = (await resp.json()) as VideoFrameMetadata;
        const participant = metadata.participant?.name ?? "?";
        const sourceType = metadata.type ?? "?";
        const frameAt = metadata.timestamp?.absolute ?? metadata.updated_at ?? "?";
        process.stdout.write(`Last frame at: ${frameAt}\n`);
        process.stdout.write(`Last frame source: ${sourceType} / ${participant}\n`);
        if (metadata.source_key) {
          process.stdout.write(`Last frame source key: ${metadata.source_key}\n`);
        }
        if (metadata.visual_status) {
          process.stdout.write(`Last frame visual status: ${metadata.visual_status}\n`);
        }
        if (metadata.updated_at) {
          process.stdout.write(`Last frame received at: ${metadata.updated_at}\n`);
        }
      } else {
        process.stdout.write(`Last frame: unavailable (${resp.status})\n`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      process.stdout.write(`Last frame: unavailable (${message})\n`);
    }
    try {
      const framesUrl = frameMetadataUrl.replace(/\/frame\.json(?:\?.*)?$/, "/frames.json");
      const resp = await fetchFn(framesUrl, { headers });
      if (resp.ok) {
        const inventory = (await resp.json()) as FrameInventory;
        const frames = inventory.frames ?? [];
        if (frames.length) {
          process.stdout.write(`Frame sources: ${frames.length}\n`);
          for (const frame of frames) {
            const source = frame.source_key ?? "?";
            const type = frame.type ?? "?";
            const participant = frame.participant?.name ?? frame.participant?.id ?? "?";
            const visual = frame.visual_status ?? "unknown";
            process.stdout.write(`  ${source}: ${type} / ${participant} (${visual})\n`);
          }
        }
      }
    } catch {
      // Older local servers do not expose inventory; last-frame metadata is enough.
    }
  }
}
