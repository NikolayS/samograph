// Guards the self-hosted JetBrains Mono weight files in apps/web/app/fonts.
//
// Regression context: all three weight files (400/500/700) were once
// byte-identical copies of the Regular 400 file, so every bold/medium style on
// samograph.dev fell back to faux/regular rendering.
//
// Why we do NOT parse the OS/2 table's usWeightClass here: WOFF2 stores font
// tables Brotli-compressed as one stream with a *transformed* (non-sfnt) table
// layout, so extracting OS/2 requires a real WOFF2 decoder — impractical in
// pure JS without adding a dependency. Instead we assert the cheap invariants
// that distinguish real weight files from the broken duplicate state:
// WOFF2 magic bytes, pairwise-distinct content hashes, and a size sanity check.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fontsDir = join(import.meta.dir, "..", "app", "fonts");
const weights = [400, 500, 700] as const;
const files = weights.map((weight) => ({
  weight,
  path: join(fontsDir, `jetbrains-mono-${weight}-latin.woff2`),
}));

describe("JetBrains Mono woff2 weight files", () => {
  it("each file is a valid WOFF2 (magic bytes 'wOF2') of plausible size", () => {
    for (const { path } of files) {
      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      // A latin-subset JetBrains Mono weight is tens of KB; catch truncated or
      // placeholder files.
      expect(bytes.byteLength).toBeGreaterThan(10_000);
      expect(bytes.byteLength).toBeLessThan(200_000);
    }
  });

  it("the 400/500/700 files are pairwise distinct (not copies of one weight)", () => {
    const hashes = files.map(({ weight, path }) => ({
      weight,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }));
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        expect(
          hashes[i]!.sha256,
          `jetbrains-mono-${hashes[i]!.weight}-latin.woff2 and jetbrains-mono-${hashes[j]!.weight}-latin.woff2 must be different fonts`,
        ).not.toBe(hashes[j]!.sha256);
      }
    }
  });
});
