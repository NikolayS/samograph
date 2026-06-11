import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const RECALL_BASE = "https://us-east-1.recall.ai/api/v1";

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

/** Path to the runtime state.json. Overridable via SAMOGRAPH_STATE_FILE for tests. */
export function stateFile(): string {
  return (
    process.env.SAMOGRAPH_STATE_FILE ??
    join(homedir(), ".samograph", "state.json")
  );
}

/** Directory containing keyword dictionaries. Overridable via SAMOGRAPH_DICT_DIR for tests. */
export function dictDir(): string {
  return process.env.SAMOGRAPH_DICT_DIR ?? join(repoRoot(), "dictionaries");
}

/** Default transcript directory (~/.samograph or under SAMOGRAPH_HOME). */
export function samographDir(): string {
  const base = process.env.SAMOGRAPH_HOME ?? homedir();
  return join(base, ".samograph");
}

/** Default transcript file path. Overridable via SAMOGRAPH_HOME for tests. */
export function defaultTranscriptFile(): string {
  return join(samographDir(), "transcript.txt");
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
