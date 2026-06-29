import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

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

/** Path to the persistent config file. Overridable via SAMOGRAPH_CONFIG_FILE for tests. */
export function configFile(): string {
  return (
    process.env.SAMOGRAPH_CONFIG_FILE ??
    join(homedir(), ".samograph", "config.json")
  );
}

/** Shape of the persisted config file. */
export interface SamographConfig {
  recall_api_key?: string;
}

/** Read and parse the config file, returning {} on missing or malformed file. */
export function readConfig(): SamographConfig {
  const path = configFile();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as SamographConfig;
    }
    return {};
  } catch {
    return {};
  }
}

/** Write (merge) a key into the config file, creating the directory if needed. */
export function writeConfig(key: string, value: string): void {
  const path = configFile();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const existing = readConfig();
  const updated = { ...existing, [key]: value };
  writeFileSync(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

export function apiKey(): string {
  // Env var takes precedence over the config file.
  const fromEnv = process.env.RECALL_API_KEY ?? "";
  if (fromEnv) return fromEnv;

  const fromConfig = readConfig().recall_api_key ?? "";
  if (fromConfig) return fromConfig;

  process.stderr.write(
    "Error: RECALL_API_KEY not set\n" +
      "  Set it via env var: export RECALL_API_KEY=<key>\n" +
      "  Or store it once:   samograph config set recall-api-key <key>\n",
  );
  throw new ExitError(1);
}

export function headers(): Record<string, string> {
  return {
    Authorization: `Token ${apiKey()}`,
    "Content-Type": "application/json",
  };
}
