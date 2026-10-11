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

/**
 * Deploy-tag grammar contract.
 *
 * samohost only treats a tag as a production deploy candidate when it matches
 * (NikolayS/samohost src/commands/app.ts:1212):
 *
 *   ^v(\d{4})(\d{2})(\d{2})\.([1-9]\d*)$     e.g. v20260904.1
 *
 * Two things in this repo must agree with that grammar, or a release either
 * silently fails to deploy or fires an unwanted npm publish:
 *
 *   1. `.github/workflows/npm-publish.yml` must SKIP releases whose tag is a
 *      deploy tag — a `gh release create v20260904.1` fires `release: published`
 *      and would otherwise npm-publish whatever version package.json holds.
 *   2. `.github/workflows/release.yml` must exist to cut those tags, and must
 *      verify CI is green before creating the release.
 */
const DEPLOY_TAG_RE = /^v(\d{4})(\d{2})(\d{2})\.([1-9]\d*)$/;
const WORKFLOW_DIR = join(import.meta.dir, "..", ".github", "workflows");

describe("deploy-tag grammar (samohost app.ts:1212)", () => {
  it("matches dated deploy tags and rejects npm-style tags", () => {
    expect(DEPLOY_TAG_RE.test("v20260904.1")).toBe(true);
    expect(DEPLOY_TAG_RE.test("v20260904.12")).toBe(true);
    // Old npm tags are ignored by the deploy channel.
    expect(DEPLOY_TAG_RE.test("v0.8.0")).toBe(false);
    expect(DEPLOY_TAG_RE.test("v1.2.3")).toBe(false);
    // N is 1-based with no leading zero; the date part is exactly 8 digits.
    expect(DEPLOY_TAG_RE.test("v20260904.0")).toBe(false);
    expect(DEPLOY_TAG_RE.test("v20260904.01")).toBe(false);
    expect(DEPLOY_TAG_RE.test("v2026094.1")).toBe(false);
    expect(DEPLOY_TAG_RE.test("20260904.1")).toBe(false);
  });

  it("npm-publish.yml guards against publishing on a deploy tag", () => {
    const wf = readFileSync(join(WORKFLOW_DIR, "npm-publish.yml"), "utf8");
    // A guard job whose output gates the publish job.
    expect(wf).toMatch(/^\s{2}guard:/m);
    expect(wf).toMatch(/needs:\s*guard/);
    expect(wf).toMatch(/if:\s*needs\.guard\.outputs\.publish == 'true'/);
    // The shell matcher must be anchored on the dated grammar, not a loose
    // startsWith() that would also swallow a real npm tag like v2.1.0.
    expect(wf).toContain("^v[0-9]{8}\\.[1-9][0-9]*$");
    expect(wf).toContain("github.event.release.tag_name");
  });

  it("release.yml cuts dated tags only after checking CI is green", () => {
    const wf = readFileSync(join(WORKFLOW_DIR, "release.yml"), "utf8");
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).toMatch(/contents:\s*write/);
    // `gh api .../actions/workflows/...` needs the Actions read scope.
    expect(wf).toMatch(/actions:\s*read/);
    // Two release runs must never race; a queued one waits rather than cancels.
    expect(wf).toMatch(/concurrency:/);
    expect(wf).toMatch(/group:\s*release/);
    expect(wf).toMatch(/cancel-in-progress:\s*false/);
    expect(wf).toContain("gh release create");
    // The release must be pinned to the SHA whose CI was verified, NOT to the
    // moving `main` ref — `--target main` re-resolves at creation time and
    // could tag a commit CI never greened.
    expect(wf).toContain('--target "$SHA"');
    expect(wf).not.toContain("--target main");
    // CI-green gate on the SHA being tagged, plus the ancestor-of-main check
    // samohost itself enforces.
    expect(wf).toContain("workflows/ci.yml/runs?head_sha=");
    expect(wf).toContain("git merge-base --is-ancestor");
    // Tag arithmetic lives in the tested script, not inline in YAML.
    expect(wf).toContain("./scripts/next-release-tag.sh");
  });
});

/**
 * `scripts/next-release-tag.sh` — the N arithmetic, exercised for real.
 *
 * N must be **max(N for today) + 1**, never "the first free N": deleting
 * v20260904.5 out of .1 … .12 must not make us reuse .5, which is older than
 * .12 and would be rejected by samohost's strictly-newer rule.
 */
const SCRIPT = join(import.meta.dir, "..", "scripts", "next-release-tag.sh");

function nextTag(today: string, tags: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bash", SCRIPT, today], {
    stdin: Buffer.from(tags.join("\n") + (tags.length ? "\n" : "")),
  });
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout).trim(),
    err: new TextDecoder().decode(proc.stderr).trim(),
  };
}

describe("scripts/next-release-tag.sh", () => {
  it("starts at .1 when the repo has no deploy tags", () => {
    const r = nextTag("20260904", []);
    expect(r.code).toBe(0);
    expect(r.out).toBe("v20260904.1");
  });

  it("ignores old npm-style tags entirely", () => {
    const r = nextTag("20260904", ["v0.8.0", "v1.2.3", "v2.0.0-rc.1"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("v20260904.1");
  });

  it("uses max(N)+1, not the first free N, when today's tags have a gap", () => {
    // .5 was deleted. First-free would pick v20260904.5 — older than .12 and a
    // name that already existed. max+1 must pick .13.
    const tags = [
      "v20260904.1", "v20260904.2", "v20260904.3", "v20260904.4",
      "v20260904.6", "v20260904.7", "v20260904.8", "v20260904.9",
      "v20260904.10", "v20260904.11", "v20260904.12",
    ];
    const r = nextTag("20260904", tags);
    expect(r.code).toBe(0);
    expect(r.out).toBe("v20260904.13");
  });

  it("compares N numerically, not lexically (.12 beats .2)", () => {
    const r = nextTag("20260904", ["v20260904.2", "v20260904.12"]);
    expect(r.out).toBe("v20260904.13");
  });

  it("rolls to .1 on a new day, ignoring yesterday's high N", () => {
    const r = nextTag("20260905", ["v20260904.12"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("v20260905.1");
  });

  it("fails when the computed tag would not be strictly newer", () => {
    // A future-dated tag already exists (clock skew / a mistaken tag).
    const r = nextTag("20260904", ["v20261231.1"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not strictly newer");
  });

  it("always emits a tag in the samohost deploy grammar", () => {
    const r = nextTag("20260904", ["v20260904.9", "v0.8.0"]);
    expect(DEPLOY_TAG_RE.test(r.out)).toBe(true);
    expect(r.out).toBe("v20260904.10");
  });
});
