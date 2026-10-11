import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mobile audit M7 — the dashboard call row.
 *
 * Before: the row was a bold mono URL (`.samograph-call-url`, weight 600) with a
 * chip under it, no title, no time, and at 390px the row did not read as one tap
 * target. This guard pins the new shape: a title line, a wrapping meta line, and
 * a row that is at least one `--control-h` (44px) tall at every width.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

function rule(selector: string, scope = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return normalize(scope.match(new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "");
}

/** The body of the `@media (max-width: 40rem)` block that owns the dashboard. */
const narrow = (() => {
  const start = css.indexOf("@media (max-width: 40rem) {\n  .samograph-dash-hero-form");
  if (start === -1) return "";
  return css.slice(start, css.indexOf("\n}", start));
})();

describe("the dashboard call row (M7)", () => {
  it("is one tap target at least --control-h tall", () => {
    const row = rule(".samograph-call-row");
    expect(row).toMatch(/min-height\s*:\s*var\(--control-h\)/);
  });

  it("leads with a title line that truncates instead of wrapping", () => {
    const title = rule(".samograph-call-title");
    expect(title).toMatch(/font-weight\s*:\s*600/);
    expect(title).toMatch(/color\s*:\s*var\(--ink\)/);
    expect(title).toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(title).toMatch(/white-space\s*:\s*nowrap/);
    expect(title).toMatch(/overflow\s*:\s*hidden/);
  });

  it("puts chip, time and URL on one wrapping meta line", () => {
    const meta = rule(".samograph-call-meta");
    expect(meta).toMatch(/display\s*:\s*flex/);
    expect(meta).toMatch(/flex-wrap\s*:\s*wrap/);
    expect(meta).toMatch(/align-items\s*:\s*center/);
    expect(meta).toMatch(/gap\s*:\s*var\(--space-1\)\s+var\(--space-2\)/);
    expect(meta).toMatch(/font-size\s*:\s*var\(--text-sm\)/);
    expect(meta).toMatch(/color\s*:\s*var\(--muted\)/);
  });

  it("demotes the URL from headline to muted mono meta text", () => {
    const url = rule(".samograph-call-url");
    expect(url).toMatch(/font-family\s*:\s*var\(--font-mono\)/);
    expect(url).toMatch(/font-size\s*:\s*var\(--text-xs\)/);
    expect(url).toMatch(/color\s*:\s*var\(--muted\)/);
    // The audit's headline defect: the URL was the row's 600-weight title.
    expect(url).not.toMatch(/font-weight\s*:\s*600/);
  });

  it("keeps the relative time on the row's ink scale, not shrunk further", () => {
    expect(rule(".samograph-call-time")).toMatch(/white-space\s*:\s*nowrap/);
  });

  it("stacks the row and keeps a 44px CTA below 40rem", () => {
    expect(narrow).not.toBe("");
    expect(rule(".samograph-call-row, .samograph-meeting-item", narrow)).toMatch(
      /grid-template-columns\s*:\s*minmax\(0, 1fr\)/,
    );
    expect(rule(".samograph-call-cta", narrow)).toMatch(
      /min-height\s*:\s*var\(--control-h\)/,
    );
    // The title names the call on a phone; the URL would only add a third line.
    expect(rule(".samograph-call-url", narrow)).toMatch(/display\s*:\s*none/);
  });
});
