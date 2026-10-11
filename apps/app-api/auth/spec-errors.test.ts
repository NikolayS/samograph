import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_ERRORS } from "./errors.ts";
import type { AuthErrorCode } from "./types.ts";

/**
 * The SPEC §5.16 table is the THIRD copy of the auth error copy (issue #225).
 *
 * `apps/app-api/auth/errors.ts` and `apps/web/lib/authErrors.ts` are already
 * asserted byte-for-byte against each other, because a silent edit to either is
 * a user-visible drift. Folding SPEC amendment S5-1 back into
 * `blueprints/samograph-dev/SPEC.md` adds a third place the same sentences live
 * — and a doc copy that quietly diverges from the shipped string is exactly the
 * drift the SPEC exists to prevent, only harder to notice because nothing runs
 * it. So the doc is pinned by a test too: the §5.16 table is parsed as data and
 * every `SAMO-AUTH-*` row is compared against `AUTH_ERRORS`.
 *
 * DOC-ONLY and DOM-free: it reads the markdown as text. It asserts the message
 * column, not the prose around it.
 */

const SPEC = readFileSync(
  join(import.meta.dir, "..", "..", "..", "blueprints", "samograph-dev", "SPEC.md"),
  "utf8",
);

/**
 * `| \`SAMO-AUTH-006\` | … | … | "copy" | … |` → `["SAMO-AUTH-006", "copy"]`.
 *
 * Throws — rather than skipping or overwriting — on a row it cannot read or on a
 * code documented twice. A duplicate used to be silently deduped by `Map.set`,
 * which made "exactly once" a lie in one direction: a drifted row followed later
 * by a correct one for the same code passed, because the correct one overwrote
 * the drift. Order must not decide whether the build is green.
 */
function specAuthRows(markdown: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    const match = /^\| `(SAMO-AUTH-[0-9]{3})` \|/.exec(line);
    if (!match) continue;
    const code = match[1]!;
    // Cells: ["", code, status, meaning, message, behavior, ""].
    const cells = line.split("|").map((c) => c.trim());
    const message = cells[4] ?? "";
    if (!(message.startsWith('"') && message.endsWith('"'))) {
      throw new Error(
        `SPEC §5.16 row ${code}: column 4 is not a quoted user-facing message ` +
          `(read ${JSON.stringify(message)}) — has the table's shape changed?`,
      );
    }
    if (rows.has(code)) {
      throw new Error(
        `SPEC §5.16 documents ${code} more than once — the table must carry exactly ` +
          `one row per code, or which copy ships is decided by row order.`,
      );
    }
    rows.set(code, message.slice(1, -1));
  }
  return rows;
}

/** The real §5.16 table with one `SAMO-AUTH-007` row duplicated, copy drifted. */
function specWithDuplicateRow(order: "drift-first" | "correct-first"): string {
  const correct = /^\| `SAMO-AUTH-007` \|.*$/m.exec(SPEC)?.[0];
  if (!correct) throw new Error("fixture: no SAMO-AUTH-007 row found in SPEC.md");
  const drifted = correct.replace(
    AUTH_ERRORS["SAMO-AUTH-007"].message,
    "Copy nobody ever shipped.",
  );
  if (drifted === correct) throw new Error("fixture: SAMO-AUTH-007 copy not found in its row");
  return SPEC.replace(
    correct,
    order === "drift-first" ? `${drifted}\n${correct}` : `${correct}\n${drifted}`,
  );
}

describe("SPEC §5.16 error table (S5-1 fold-in, #225)", () => {
  test("documents every SAMO-AUTH code that ships, exactly once", () => {
    const documented = specAuthRows(SPEC);
    expect([...documented.keys()].sort()).toEqual(
      Object.keys(AUTH_ERRORS).filter((code) => code.startsWith("SAMO-AUTH-")).sort(),
    );
  });

  test("every documented message is byte-identical to AUTH_ERRORS", () => {
    const documented = specAuthRows(SPEC);
    for (const [code, message] of documented) {
      expect(message).toBe(AUTH_ERRORS[code as AuthErrorCode].message);
    }
  });

  test.each(["drift-first", "correct-first"] as const)(
    "a code documented twice fails loudly (%s) — order cannot decide the verdict",
    (order) => {
      const mutated = specWithDuplicateRow(order);
      expect(() => specAuthRows(mutated)).toThrow(/documents SAMO-AUTH-007 more than once/);
    },
  );

  test("a row whose message column is not a quoted string fails loudly", () => {
    const correct = /^\| `SAMO-AUTH-007` \|.*$/m.exec(SPEC)?.[0];
    expect(correct).toBeDefined();
    // Drop the closing `"` — the shape assertion, not the copy comparison, must catch it.
    const malformed = correct!.replace(
      `"${AUTH_ERRORS["SAMO-AUTH-007"].message}"`,
      `"${AUTH_ERRORS["SAMO-AUTH-007"].message}`,
    );
    expect(malformed).not.toBe(correct);
    expect(() => specAuthRows(SPEC.replace(correct!, malformed))).toThrow(
      /column 4 is not a quoted user-facing message/,
    );
  });
});
