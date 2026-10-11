import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Follow-up from the #280 review. An inline `SAMOGRAPH-WARNING` line is rendered
 * as a bare `<li>` inside `.samograph-instrument-lines`, so it matched only the
 * baseline rule
 *
 *   .samograph-instrument-lines li { grid-template-columns: 56px 82px 66px minmax(480px, 1fr) }
 *
 * — a 480px minimum utterance column plus three fixed columns and three 14px
 * gaps, i.e. ~684px of intrinsic minimum width. Every transcript row that is a
 * real utterance opts out of that grid via `.samograph-transcript-row`; the
 * warning row did not, so the whole transcript scrolled horizontally at 390px
 * the moment a warning existed. The warning row is one full-width cell instead.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start) + 1);
}

describe("SAMOGRAPH-WARNING transcript row CSS", () => {
  const selector = ".samograph-instrument-lines > li.samograph-warning-row";

  it("takes the warning row off the fixed four-column transcript grid", () => {
    expect(rule(selector)).toMatch(/display\s*:\s*block/);
  });

  it("never re-declares a fixed-width column track for the warning row", () => {
    expect(rule(selector)).not.toMatch(/grid-template-columns/);
    expect(rule(selector)).not.toMatch(/minmax\(480px/);
  });

  it("applies at every viewport, not only inside a media query", () => {
    // Everything before the rule must have balanced braces — a rule nested in an
    // `@media` block would leave one open.
    const head = css.slice(0, css.indexOf(selector));
    const depth = head.split("{").length - head.split("}").length;
    expect(depth).toBe(0);
  });

  it("drops the tally-rail counter the instrument hides on every other row", () => {
    expect(css).toMatch(
      /\.samograph-percall \.samograph-warning-row::before,\s*\.samograph-percall \.samograph-warning-row::after\s*\{\s*content\s*:\s*none;\s*\}/,
    );
  });

  it("keeps the warn-toned system-note styling on the line itself", () => {
    expect(rule(".samograph-warning-line")).toMatch(/color\s*:\s*var\(--warn\)/);
  });
});
