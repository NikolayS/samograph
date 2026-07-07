/**
 * Integration test: dev-local.sh restart robustness
 *
 * Regression for: "Could not open pid file samograph.pid: Permission denied"
 *
 * Root cause: dev-local.sh writes PID files to .dev-local/ relative to the
 * repo root.  When a preview VM is first set up by root (samohost bootstrap),
 * .dev-local/ ends up root-owned and unwritable by the app user. On any
 * subsequent restart the `echo $$ > "$LOGDIR/samograph.pid"` redirect fails
 * with "Permission denied", killing the whole script under `set -euo pipefail`.
 *
 * Before fix: the script has no concept of SAMOGRAPH_LOGDIR or dry-run mode,
 * so running it always tries to contact Docker, failing with "Docker daemon not
 * reachable" in CI — and on a VM where .dev-local/ is root-owned it fails with
 * "Permission denied" before Docker is even reached.
 *
 * Fix:
 *   1. SAMOGRAPH_DEV_LOCAL_DRY_RUN=1 mode: skips Docker/bun/next starts so the
 *      PID-file management path is exercisable without a real service stack.
 *   2. SAMOGRAPH_LOGDIR override: allows overriding LOGDIR for tests and
 *      operator use.
 *   3. _resolve_logdir(): probes writability; falls back to a per-user tmp dir
 *      if the canonical .dev-local/ (or the overridden LOGDIR) is not writable.
 *   4. _cleanup_stale_pid(): removes a stale samograph.pid whose process is no
 *      longer alive before attempting to write a fresh one.
 *
 * Test strategy: use SAMOGRAPH_DEV_LOCAL_DRY_RUN=1 + SAMOGRAPH_LOGDIR to
 * exercise PID-management paths in isolation.  All tests below FAIL before the
 * fix (the script either errors on Docker or on a permission-denied write) and
 * PASS after the fix.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "scripts", "dev-local.sh");

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "samograph-test-"));
}

describe("dev-local.sh restart robustness", () => {
  let tmpRoot: string;
  // Per-user fallback dir that _resolve_logdir() uses when SAMOGRAPH_LOGDIR is unwritable.
  const fallbackDir = `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/samograph-${userInfo().uid}`;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
    // Clean any leftover fallback dir from a previous test run.
    rmSync(fallbackDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Re-enable write so rmSync can clean up the test dirs.
    try { chmodSync(join(tmpRoot, ".dev-local"), 0o755); } catch { /* ok */ }
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  });

  it("exits 0 in dry-run mode with a writable LOGDIR", () => {
    // Baseline: confirms the dry-run mode itself works correctly.
    const logdir = join(tmpRoot, ".dev-local");
    mkdirSync(logdir, { recursive: true });

    const result = spawnSync("bash", [SCRIPT, "start"], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        SAMOGRAPH_LOGDIR: logdir,
        SAMOGRAPH_DEV_LOCAL_DRY_RUN: "1",
      },
      timeout: 10_000,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    // Master PID file must be written.
    expect(existsSync(join(logdir, "samograph.pid"))).toBe(true);
  });

  it("exits 0 even when the given LOGDIR is unwritable (fallback to tmp)", () => {
    // Simulates the samohost scenario: .dev-local/ was created by root on first
    // deploy, is now chmod 555, and the app user tries to restart the stack.
    const logdir = join(tmpRoot, ".dev-local");
    mkdirSync(logdir, { recursive: true });
    chmodSync(logdir, 0o555); // simulate root-owned: not writable by app user

    const result = spawnSync("bash", [SCRIPT, "start"], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        SAMOGRAPH_LOGDIR: logdir,
        SAMOGRAPH_DEV_LOCAL_DRY_RUN: "1",
      },
      timeout: 10_000,
      encoding: "utf-8",
    });

    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(result.status).toBe(0);
    // The fallback runtime dir must now hold the master PID.
    expect(existsSync(join(fallbackDir, "samograph.pid"))).toBe(true);
    // The original unwritable dir must NOT have been written to.
    expect(readdirSync(logdir)).toEqual([]);
  });

  it("exits 0 when a stale samograph.pid exists (restart scenario)", () => {
    // Simulates a restart after an unclean shutdown: samograph.pid contains a
    // PID that no longer exists.  The script must remove it and proceed.
    const logdir = join(tmpRoot, ".dev-local");
    mkdirSync(logdir, { recursive: true });
    const pidFile = join(logdir, "samograph.pid");
    writeFileSync(pidFile, "999999999"); // guaranteed non-existent PID

    const result = spawnSync("bash", [SCRIPT, "start"], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        SAMOGRAPH_LOGDIR: logdir,
        SAMOGRAPH_DEV_LOCAL_DRY_RUN: "1",
      },
      timeout: 10_000,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    // The stale PID (999999999) must have been replaced with the real PID.
    const newPid = parseInt(
      require("node:fs").readFileSync(pidFile, "utf-8").trim(),
      10
    );
    expect(newPid).not.toBe(999999999);
    expect(newPid).toBeGreaterThan(0);
  });
});
