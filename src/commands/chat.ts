import { botIdFromArgsOrState, loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";
import { chimeNames, resolveChime } from "../chime.ts";

export interface ChatDeps {
  recall?: RecallClient;
  fetchFn?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

// Best-effort: play the chime into the call's audio track so participants
// *hear* that the bot posted a message. Never throws — chat must succeed even
// if audio output fails or is unavailable. This is the audible path; the
// presence-camera WebAudio cue (ringChime) is video-only and inaudible in a
// headless renderer, so it stays only as an on-page nicety.
async function ringCallAudio(
  recall: RecallClient,
  botId: string,
  mp3Base64: string,
): Promise<void> {
  try {
    const resp = await recall.outputAudio(botId, mp3Base64);
    if (!resp.ok) await resp.text().catch(() => "");
  } catch {
    // ignore — the chime is a non-critical nicety
  }
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

// Pick the chime for this message. Precedence: --chime flag, else the
// session default saved at join time (state.chime), else the library default.
// An unknown name falls back to the default and prints a one-line warning.
function selectChime(args: ParsedArgs): { name: string; mp3Base64: string } {
  const requested = args.chime ?? loadState().chime;
  const resolved = resolveChime(requested);
  if (resolved.fellBack) {
    process.stderr.write(
      `samograph: warning: unknown chime '${String(requested)}', using '${resolved.name}' ` +
        `(available: ${chimeNames().join(", ")})\n`,
    );
  }
  return { name: resolved.name, mp3Base64: resolved.mp3Base64 };
}

export async function cmdChat(
  args: ParsedArgs,
  deps: ChatDeps = {},
): Promise<void> {
  if (args.list_chimes) {
    process.stdout.write(`${chimeNames().join("\n")}\n`);
    return;
  }
  const recall = deps.recall ?? makeRecallClient();
  const bid = botIdFromArgsOrState(args.bot_id);
  const chime = selectChime(args);
  const resp = await recall.sendChat(bid, args.message ?? "");
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`send_chat_message failed: ${resp.status} ${body}`);
  }
  await ringCallAudio(recall, bid, chime.mp3Base64);
  await ringChime(deps.fetchFn ?? fetch);
  process.stdout.write(`Sent: ${args.message}\n`);
}
