import { ExitError } from "../config.ts";
import { loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import {
  defaultPresenceMessage,
  normalizePresenceState,
  sanitizePresenceMessage,
  sanitizePresenceText,
} from "../presence.ts";

export interface PresenceDeps {
  fetchFn?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function cmdPresence(
  args: ParsedArgs,
  deps: PresenceDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const stateName = normalizePresenceState(args.presence_state);
  if (stateName === null) {
    process.stderr.write(
      "Error: presence state must be one of: listening, thinking, speaking, acting, idle\n",
    );
    throw new ExitError(1);
  }

  const state = loadState();
  const updateUrl = state.local_presence_update_url;
  const token = state.presence_write_token;
  if (typeof updateUrl !== "string" || !updateUrl || typeof token !== "string" || !token) {
    process.stderr.write(
      "Error: no active dynamic presence server found. Run samocall join first.\n",
    );
    throw new ExitError(1);
  }

  // Bare state toggles omit message entirely so the server applies the
  // default without polluting the Comments activity lane. A message that
  // sanitizes to empty (e.g. whitespace-only) is treated as omitted too.
  const explicitMessage =
    args.message === undefined || sanitizePresenceText(args.message) === ""
      ? null
      : sanitizePresenceMessage(args.message, stateName);
  const message = explicitMessage ?? defaultPresenceMessage(stateName);
  try {
    const resp = await fetchFn(updateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Samocall-Presence-Token": token,
      },
      body: JSON.stringify(
        explicitMessage === null
          ? { state: stateName }
          : { state: stateName, message: explicitMessage },
      ),
    });
    if (!resp.ok) {
      const body = await resp.text();
      process.stderr.write(`Error: presence update failed: ${resp.status} ${body}\n`);
      throw new ExitError(1);
    }
  } catch (err) {
    if (err instanceof ExitError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: presence update failed: ${reason}\n`);
    throw new ExitError(1);
  }
  process.stdout.write(`Presence: ${stateName} - ${message}\n`);
}
