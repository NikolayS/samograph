import { botIdFromArgsOrState, loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";

export interface ChatDeps {
  recall?: RecallClient;
  fetchFn?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

// Best-effort: ping the local presence server so the bot camera plays a chime
// for the message we just posted. Never throws — chat must succeed even when
// there is no presence server (e.g. --no-presence) or the ping fails.
async function ringChime(
  fetchFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  try {
    const state = loadState();
    const presenceUrl = state.local_presence_update_url;
    const token = state.presence_write_token;
    if (typeof presenceUrl !== "string" || !presenceUrl) return;
    if (typeof token !== "string" || !token) return;
    const u = new URL(presenceUrl);
    u.pathname = "/chime";
    await fetchFn(u.toString(), {
      method: "POST",
      headers: { "X-Samograph-Presence-Token": token },
    });
  } catch {
    // ignore — the chime is a non-critical nicety
  }
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
  await ringChime(deps.fetchFn ?? fetch);
  process.stdout.write(`Sent: ${args.message}\n`);
}
