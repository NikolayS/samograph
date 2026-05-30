import { botIdFromArgsOrState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";

export interface ChatDeps {
  recall?: RecallClient;
}

export async function cmdChat(
  args: ParsedArgs,
  deps: ChatDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const bid = botIdFromArgsOrState(args.bot_id);
  const resp = await recall.sendChat(bid, args.message ?? "");
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`send_chat_message failed: ${resp.status} ${body}`);
  }
  process.stdout.write(`Sent: ${args.message}\n`);
}
