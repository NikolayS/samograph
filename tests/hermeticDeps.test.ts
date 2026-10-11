import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("hermetic deps (#60 + #61)", () => {
  test("bun.lock is tracked by git so CI --frozen-lockfile pins the graph", () => {
    const tracked = execFileSync("git", ["ls-files", "bun.lock"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("bun.lock");
  });

  test("bun.lock is not ignored by .gitignore", () => {
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    expect(lines).not.toContain("bun.lock");
  });

  test("apps/web pins @types/node so Next's type-check does not auto-install it", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "apps/web/package.json"), "utf8"),
    );
    expect(pkg.devDependencies["@types/node"]).toBe("^20.17.6");
  });

  // Guard: the workspace-root Bun program must keep its node types on the
  // major bun-types floats to (26), or apps/web's node-20 pin flips the bun
  // store's primary @types/node to 20 and regresses the CLI's tsc
  // (RequestInit.cache / ChildProcess.on). See PR #60+#61.
  test("workspace root pins @types/node to bun-types' major (26) for stable tsc", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.devDependencies["@types/node"]).toBe("^26.1.0");
  });
});
