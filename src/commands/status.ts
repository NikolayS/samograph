import { existsSync, readFileSync } from "node:fs";
import { defaultTranscriptFile } from "../config.ts";
import { loadState, botIdFromArgsOrState } from "../state.ts";
import { SENTINEL_RE } from "../transcript.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";

export interface StatusDeps {
  recall?: RecallClient;
}

export async function cmdStatus(
  args: ParsedArgs,
  deps: StatusDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
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
    process.stdout.write(`Transcript file: ${tf}\n`);
  }
}
