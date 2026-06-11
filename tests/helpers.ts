import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "samograph-"));
}

export function cleanupTmpDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const ENV_KEYS = [
  "SAMOGRAPH_STATE_FILE",
  "SAMOGRAPH_DICT_DIR",
  "SAMOGRAPH_HOME",
  "RECALL_API_KEY",
  "GOOGLE_DOC_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

export function saveEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
  }
  return snapshot;
}

export function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = snapshot[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}
