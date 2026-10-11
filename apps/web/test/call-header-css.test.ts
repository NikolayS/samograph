import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * M4 — the call-view header must stop eating the top of a phone screen.
 * These are CSS guards on `apps/web/app/globals.css` (Slice 3 region): the page
 * heading is compact, the meeting URL is a small secondary line, and the sticky
 * panel header collapses to ONE row (state + id) below 768px instead of the
 * three-row, 161px stack the mobile audit measured.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");
const slice3 = css.slice(css.indexOf("/* ===== Slice 3 — Transcript instrument"));
/**
 * Slice 3 contains TWO `@media (max-width: 48rem)` blocks — this one and the
 * later head/foot column stack — so `indexOf("@media (max-width: 48rem)")` is
 * ambiguous: reorder the file and the guard silently reads the wrong block
 * (#283 re-review NB2). Anchor on a marker comment that names this block, and
 * take the media query that immediately follows it.
 */
const MARKER = "/* M4:compact-call-header";
const mobile = (() => {
  const marker = slice3.indexOf(MARKER);
  if (marker < 0) return "";
  const start = slice3.indexOf("@media (max-width: 48rem)", marker);
  if (start < 0) return "";
  // Nested-free block: read to the matching closing brace.
  let depth = 0;
  for (let i = slice3.indexOf("{", start); i < slice3.length; i += 1) {
    if (slice3[i] === "{") depth += 1;
    else if (slice3[i] === "}") {
      depth -= 1;
      if (depth === 0) return slice3.slice(start, i + 1);
    }
  }
  return "";
})();

describe("M4 call-view header CSS", () => {
  it("styles the demoted meeting-URL line as small mono secondary text", () => {
    expect(slice3).toMatch(
      /\.samograph-call-view-url\s*\{[^}]*font-family\s*:\s*var\(--font-mono\)[^}]*font-size\s*:\s*var\(--text-sm\)/s,
    );
    // One line, ellipsised — never a wrapped block of URL.
    expect(slice3).toMatch(/\.samograph-call-view-url\s*\{[^}]*text-overflow\s*:\s*ellipsis/s);
    expect(slice3).toMatch(/\.samograph-call-view-url\s*\{[^}]*white-space\s*:\s*nowrap/s);
  });

  it("has a mobile block on the 48rem boundary inside Slice 3", () => {
    expect(mobile).not.toBe("");
  });

  it("is anchored on a marker that appears exactly once in globals.css", () => {
    expect(css.split(MARKER).length - 1).toBe(1);
  });

  it("shrinks the page H1 and its bottom margin on mobile", () => {
    expect(mobile).toMatch(/\.samograph-call-view-heading h1\s*\{[^}]*font-size\s*:\s*var\(--text-lg\)/s);
    expect(mobile).toMatch(/\.samograph-call-view-heading\s*\{[^}]*margin-bottom\s*:\s*var\(--space-3\)/s);
  });

  it("keeps the sticky panel header on ONE row (id + state) on mobile", () => {
    expect(mobile).toMatch(
      /\.samograph-percall header\.samograph-status\.samograph-instrument-head\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+auto/s,
    );
    expect(mobile).toMatch(
      /\.samograph-percall header\.samograph-status\.samograph-instrument-head\s*\{[^}]*padding\s*:\s*8px\s+12px/s,
    );
    expect(mobile).toMatch(
      /\.samograph-percall header\.samograph-status\.samograph-instrument-head\s*\{[^}]*flex-direction\s*:\s*row/s,
    );
  });

  it("drops the duplicated URL and the dictionary chip from the panel header on mobile", () => {
    expect(mobile).toMatch(
      /\.samograph-instrument-url,\s*\.samograph-instrument-dictionary\s*\{\s*display\s*:\s*none;\s*\}/s,
    );
  });

  it("does not touch the transcript-row grids owned by M1", () => {
    expect(mobile).not.toMatch(/samograph-transcript-row/);
  });
});
