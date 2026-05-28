import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { dictDir } from "../config.ts";

export async function cmdDicts(): Promise<void> {
  const dir = dictDir();
  if (!existsSync(dir)) {
    process.stdout.write("No dictionaries directory found.\n");
    return;
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => join(dir, f));
  if (!files.length) {
    process.stdout.write("No dictionaries found.\n");
    return;
  }
  process.stdout.write("Available dictionaries:\n");
  for (const f of files) {
    const terms = readFileSync(f, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const stem = basename(f, ".txt");
    process.stdout.write(`  ${stem} (${terms.length} terms)\n`);
  }
}
