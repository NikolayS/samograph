import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * .samohost.toml release-tag-gate contract.
 *
 * samohost's manifest loader (NikolayS/samohost src/manifest/toml.ts:1141-1166 +
 * app/release-policy.ts) REQUIRES two additional fields whenever
 * `releaseTagPattern` is present, and `samohost app register` FAILS validation
 * without them:
 *
 *   releaseTagFormat  = "date"                     (must be the literal "date")
 *   releaseCiWorkflow = ".github/workflows/ci.yml"  (canonical CI workflow path)
 *
 * Until both are present the manifest cannot be registered, so prod cannot be
 * tag-gated (it keeps auto-deploying `main` -> prod, the wrong-vs-target
 * behavior). This guard keeps the required-field contract from silently
 * regressing: if the file declares `releaseTagPattern`, it MUST also declare
 * both canonical fields with their exact canonical values.
 */

const TOML_PATH = join(import.meta.dir, "..", ".samohost.toml");

describe(".samohost.toml release-tag-gate contract", () => {
  const toml = readFileSync(TOML_PATH, "utf8");

  // A key at the start of a line (optionally indented) — never inside a `#` comment.
  const hasReleaseTagPattern = /^[ \t]*releaseTagPattern[ \t]*=/m.test(toml);

  it("declares releaseTagPattern (the file gates prod on a release tag)", () => {
    // Sanity anchor: this whole contract only matters because the manifest
    // opts into tag-gated prod releases. If this ever flips, the required-field
    // assertions below still hold vacuously, so make the premise explicit.
    expect(hasReleaseTagPattern).toBe(true);
  });

  it("when releaseTagPattern is present, requires releaseTagFormat = \"date\"", () => {
    if (!hasReleaseTagPattern) return; // vacuously satisfied without the pattern
    // Exact canonical value, tolerant of surrounding whitespace / alignment.
    expect(toml).toMatch(/^[ \t]*releaseTagFormat[ \t]*=[ \t]*"date"/m);
  });

  it("when releaseTagPattern is present, requires releaseCiWorkflow = \".github/workflows/ci.yml\"", () => {
    if (!hasReleaseTagPattern) return; // vacuously satisfied without the pattern
    // Exact canonical path, tolerant of surrounding whitespace / alignment.
    expect(toml).toMatch(
      /^[ \t]*releaseCiWorkflow[ \t]*=[ \t]*"\.github\/workflows\/ci\.yml"/m,
    );
  });

  it("still parses as valid TOML", () => {
    // Use Bun's built-in TOML parser when available; otherwise keep the text
    // asserts above as the contract and skip the parse check.
    const parse = (globalThis as { Bun?: { TOML?: { parse?: (s: string) => unknown } } }).Bun?.TOML?.parse;
    if (typeof parse !== "function") return;
    const parsed = parse(toml) as Record<string, unknown>;
    expect(parsed.releaseTagPattern).toBe("v*");
    // Once the two required fields are added, they must parse to canonical values.
    expect(parsed.releaseTagFormat).toBe("date");
    expect(parsed.releaseCiWorkflow).toBe(".github/workflows/ci.yml");
  });
});
