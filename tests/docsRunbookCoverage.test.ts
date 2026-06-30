import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * On-call runbook coverage (§8 SRE track / §5.16 error-code reference).
 *
 * Guards that the four operator runbooks exist and that every operator-reachable
 * terminal call status and every operator-facing `SAMO-*` error code is actually
 * documented somewhere in the runbook set — so an on-call engineer hitting a code
 * always has a page to turn to. The leader-election runbook must name the
 * advisory-lock mechanism and its 60 s lease / 20 s renew numbers (§4.6).
 */
const RUNBOOK_DIR = join(import.meta.dir, "..", "docs", "runbooks");

const REQUIRED_RUNBOOKS = [
  "ingest-degraded.md",
  "could-not-join.md",
  "could-not-record.md",
  "leader-election.md",
];

/** Operator-reachable TERMINAL statuses (§5.2). */
const TERMINAL_STATUSES = ["COULD_NOT_JOIN", "COULD_NOT_RECORD", "BOT_REMOVED", "ENDED"];

/** Operator-facing error codes the on-call must be able to look up (§5.16). */
const OPERATOR_CODES = [
  "SAMO-CALL-NOREC",
  "SAMO-RATE-001",
  "SAMO-INGEST-DEGRADED",
  "SAMO-WORKER-503",
];

function readAllRunbooks(): string {
  return REQUIRED_RUNBOOKS.filter((f) => existsSync(join(RUNBOOK_DIR, f)))
    .map((f) => readFileSync(join(RUNBOOK_DIR, f), "utf8"))
    .join("\n");
}

describe("docs/runbooks coverage — §8 / §5.16", () => {
  test.each(REQUIRED_RUNBOOKS)("runbook %s exists", (file) => {
    expect(existsSync(join(RUNBOOK_DIR, file))).toBe(true);
  });

  test.each(TERMINAL_STATUSES)("terminal status %s is documented in a runbook", (status) => {
    expect(readAllRunbooks()).toContain(status);
  });

  test.each(OPERATOR_CODES)("operator error code %s is documented in a runbook", (code) => {
    expect(readAllRunbooks()).toContain(code);
  });

  test("leader-election runbook names the advisory lock + 60 s/20 s lease numbers", () => {
    const path = join(RUNBOOK_DIR, "leader-election.md");
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/advisory[ -]lock/i);
    expect(body).toMatch(/region_id/);
    expect(body).toMatch(/60\s*s/i); // 60 s lease
    expect(body).toMatch(/20\s*s/i); // 20 s renew
    expect(body).toMatch(/pg_locks/);
  });
});
