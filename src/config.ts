import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const RECALL_BASE = "https://us-east-1.recall.ai/api/v1";
export const AVATAR_URL = "https://nikolays.github.io/samoagent/avatar.html";

export class ExitError extends Error {
  constructor(public code: number) {
    super(`ExitError(${code})`);
    this.name = "ExitError";
  }
}

/** Directory of this source tree (used to locate dictionaries/ alongside the repo). */
function repoRoot(): string {
  // src/config.ts -> repo root is one level up from src/
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Path to the runtime state.json. Overridable via SAMOAGENT_STATE_FILE for tests. */
export function stateFile(): string {
  return (
    process.env.SAMOAGENT_STATE_FILE ??
    join(homedir(), ".samoagent", "state.json")
  );
}

/** Directory containing keyword dictionaries. Overridable via SAMOAGENT_DICT_DIR for tests. */
export function dictDir(): string {
  return process.env.SAMOAGENT_DICT_DIR ?? join(repoRoot(), "dictionaries");
}

/** Default transcript directory (~/.samoagent or under SAMOAGENT_HOME). */
export function samoagentDir(): string {
  const base = process.env.SAMOAGENT_HOME ?? homedir();
  return join(base, ".samoagent");
}

/** Default transcript file path. Overridable via SAMOAGENT_HOME for tests. */
export function defaultTranscriptFile(): string {
  return join(samoagentDir(), "transcript.txt");
}

export function apiKey(): string {
  const k = process.env.RECALL_API_KEY ?? "";
  if (!k) {
    process.stderr.write("Error: RECALL_API_KEY not set\n");
    throw new ExitError(1);
  }
  return k;
}

export function headers(): Record<string, string> {
  return {
    Authorization: `Token ${apiKey()}`,
    "Content-Type": "application/json",
  };
}
