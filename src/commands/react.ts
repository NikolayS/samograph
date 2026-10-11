import { ExitError } from "../config.ts";
import { loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { sanitizeReactionCount, sanitizeReactionEmoji } from "../presence.ts";

export interface ReactDeps {
  fetchFn?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function cmdReact(
  args: ParsedArgs,
  deps: ReactDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const emoji = sanitizeReactionEmoji(args.emoji);
  if (emoji === null) {
    process.stderr.write("Error: reaction emoji must be a non-empty glyph (e.g. 🎉)\n");
    throw new ExitError(1);
  }
  const count = sanitizeReactionCount(args.reaction_count);

  const state = loadState();
  const presenceUrl = state.local_presence_update_url;
  const token = state.presence_write_token;
  if (typeof presenceUrl !== "string" || !presenceUrl || typeof token !== "string" || !token) {
    process.stderr.write(
      "Error: no active dynamic presence server found. Run samograph join first.\n",
    );
    throw new ExitError(1);
  }
  // The reaction endpoint lives alongside /presence on the same local server;
  // derive it by swapping the path so we reuse the stored base + port.
  let reactionUrl: string;
  try {
    const u = new URL(presenceUrl);
    u.pathname = "/reaction";
    reactionUrl = u.toString();
  } catch {
    process.stderr.write(`Error: stored presence URL is invalid: ${presenceUrl}\n`);
    throw new ExitError(1);
  }

  try {
    const resp = await fetchFn(reactionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Samograph-Presence-Token": token,
      },
      body: JSON.stringify({ emoji, count }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      process.stderr.write(`Error: reaction failed: ${resp.status} ${body}\n`);
      throw new ExitError(1);
    }
  } catch (err) {
    if (err instanceof ExitError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: reaction failed: ${reason}\n`);
    throw new ExitError(1);
  }
  process.stdout.write(`Reaction: ${emoji} x${count}\n`);
}
