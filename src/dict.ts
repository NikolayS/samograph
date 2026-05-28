import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dictDir } from "./config.ts";

export function loadDict(name?: string | null): string[] {
  if (!name || name.toLowerCase() === "none") {
    return [];
  }
  const path = join(dictDir(), `${name}.txt`);
  if (!existsSync(path)) {
    process.stdout.write(
      `Warning: dictionary '${name}' not found at ${path}, continuing without it.\n`,
    );
    return [];
  }
  const terms = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return terms.slice(0, 100); // Deepgram limit
}
