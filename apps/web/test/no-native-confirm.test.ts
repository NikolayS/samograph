import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const web = join(import.meta.dir, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("browser confirmation dialogs", () => {
  it("uses no native confirm calls in app or component source", () => {
    const offenders = [
      ...sourceFiles(join(web, "components")),
      ...sourceFiles(join(web, "app")),
    ].filter((file) => /(?:window\.)?\bconfirm\s*\(/.test(readFileSync(file, "utf8")));

    expect(offenders.map((file) => file.slice(web.length + 1))).toEqual([]);
  });
});
