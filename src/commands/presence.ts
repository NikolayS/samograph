import { ExitError } from "../config.ts";
import { loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import {
  defaultPresenceMessage,
  normalizePresenceState,
  sanitizePresenceMessage,
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
  const token = state.presence_token;
  if (typeof updateUrl !== "string" || !updateUrl || typeof token !== "string" || !token) {
    process.stderr.write(
      "Error: no active dynamic presence server found. Run samoagent join first.\n",
    );
    throw new ExitError(1);
  }

  const message = sanitizePresenceMessage(
    args.message ?? defaultPresenceMessage(stateName),
    stateName,
  );
  const resp = await fetchFn(updateUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Samoagent-Presence-Token": token,
    },
    body: JSON.stringify({ state: stateName, message }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`presence update failed: ${resp.status} ${body}`);
  }
  process.stdout.write(`Presence: ${stateName} - ${message}\n`);
}
