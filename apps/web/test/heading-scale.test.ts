import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Desktop PR 5 + PR 6 (`docs/design/PLAN.md`) — a real heading scale, a shared
 * `PageHeader`, and section rhythm.
 *
 * The bug this guards against (`docs/design/AUDIT-2026-09-04.md`, DESIGN-MODEL
 * §3 "Type scale"): `h2` was `--text-md` (16px) against a `--text-base` (14px)
 * body — a 2px step. On `/dashboard` that made four peer sections ("Add
 * samograph to a call", "Upcoming meetings", "Active calls", "Past calls") read
 * as one undifferentiated column of text. DESIGN-MODEL §3 puts `<h2>` on
 * `--text-lg` (20px) and `<h3>` on `--text-md` (16px), and DESIGN-MODEL §4
 * "Page header" / "Card / Section" define `.samograph-page-header` and
 * `.samograph-section` as the two structures that carry that hierarchy.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * A tiny top-level rule reader. `rule(".samograph-section")` finds the rule
 * whose SELECTOR LIST contains that selector, so a shared, comma-grouped rule
 * (`.samograph-dash-hero, .samograph-upcoming-meetings { … }`) is found by
 * either of its selectors rather than only by its literal text.
 */
function block(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

function rules(source: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{", cursor);
    if (open < 0) break;
    const prelude = normalize(source.slice(cursor, open));
    const body = block(source, open);
    cursor = open + body.length + 2;
    if (prelude.startsWith("@")) continue;
    out.push({ selectors: prelude.split(",").map(normalize), body: normalize(body) });
  }
  return out;
}

const topLevel = rules(css);

function rule(selector: string): string {
  return topLevel
    .filter((entry) => entry.selectors.includes(normalize(selector)))
    .map((entry) => entry.body)
    .join(" ");
}

/** The `@media (min-width: …)` block that actually mentions `selector`. */
function mediaRule(condition: string, selector: string): string {
  for (const match of css.matchAll(new RegExp(`@media\\s*\\(${condition}\\)\\s*\\{`, "g"))) {
    const body = block(css, match.index + match[0].length - 1);
    if (body.includes(selector)) return normalize(body);
  }
  return "";
}

/** `--text-*` in rem → px, so the steps can be compared as numbers. */
function step(name: string): number {
  const value = root.match(new RegExp(`--text-${name}\\s*:\\s*([\\d.]+)rem;`))?.[1];
  return value ? Number(value) * 16 : 0;
}

describe("type scale — headings actually outrank body text", () => {
  it("keeps the seven-step scale's values", () => {
    expect(step("base")).toBe(14);
    expect(step("md")).toBe(16);
    expect(step("lg")).toBe(20);
    expect(step("xl")).toBe(28);
  });

  it("puts h1 on --text-xl (28px), one per page", () => {
    expect(rule("h1")).toContain("font-size: var(--text-xl)");
  });

  it("puts h2 on --text-lg (20px) — the flatness bug was 16px", () => {
    const h2 = rule("h2");
    expect(h2).toContain("font-size: var(--text-lg)");
    expect(h2).not.toContain("font-size: var(--text-md)");
    // A section title must be a visible step above body copy, not 2px.
    expect(step("lg") - step("base")).toBeGreaterThanOrEqual(6);
  });

  it("puts h3 on --text-md (16px), a step under h2 and above body", () => {
    const h3 = rule("h3");
    expect(h3).toContain("font-size: var(--text-md)");
    expect(step("md")).toBeGreaterThan(step("base"));
    expect(step("md")).toBeLessThan(step("lg"));
  });
});

describe(".samograph-page-header — the shared page header (DESIGN-MODEL §4)", () => {
  it("is a grid with the --space-2 inner gap and --space-8 below it", () => {
    const header = rule(".samograph-page-header");
    expect(header).toContain("display: grid");
    expect(header).toContain("gap: var(--space-2)");
    expect(header).toContain("margin-bottom: var(--space-8)");
  });

  it("stacks eyebrow / title / description in one text column", () => {
    const text = rule(".samograph-page-header-text");
    expect(text).toContain("display: grid");
    expect(text).toContain("gap: var(--space-2)");
  });

  it("gives the title --text-xl/700 and no stray margin", () => {
    const title = rule(".samograph-page-header-title");
    expect(title).toContain("font-size: var(--text-xl)");
    expect(title).toContain("font-weight: 700");
    expect(title).toContain("margin: 0");
  });

  it("sets the eyebrow as small muted text above the title", () => {
    const eyebrow = rule(".samograph-page-header-eyebrow");
    expect(eyebrow).toContain("font-size: var(--text-sm)");
    expect(eyebrow).toContain("color: var(--muted)");
  });

  it("caps the description at a reading measure in muted body text", () => {
    const description = rule(".samograph-page-header-description");
    expect(description).toContain("font-size: var(--text-base)");
    expect(description).toContain("color: var(--muted)");
    expect(description).toContain("max-width: 60ch");
    expect(description).toContain("margin: 0");
  });

  it("puts the actions below on mobile and right-aligned from --bp-md up", () => {
    expect(rule(".samograph-page-header-actions")).toContain("display: flex");
    // The two-column form is a min-width rule — mobile-first, per DESIGN-MODEL §5.
    const desktop = mediaRule("min-width:\\s*768px", ".samograph-page-header--has-actions");
    expect(desktop).not.toBe("");
    expect(desktop).toContain("grid-template-columns: minmax(0, 1fr) auto");
  });
});

describe(".samograph-section — section rhythm (DESIGN-MODEL §4, §5)", () => {
  it("is a hairline-separated run of content on --space-6 padding", () => {
    const section = rule(".samograph-section");
    expect(section).toContain("padding-block: var(--space-6)");
    expect(section).toContain("border-top: var(--border) solid var(--line)");
  });

  it("drops the rule above the first section under a page header", () => {
    const first = rule(".samograph-page-header + .samograph-section");
    expect(first).toContain("border-top: 0");
    expect(first).toContain("padding-top: 0");
  });

  it("suppresses that first rule through a wrapper too (Settings' <form>)", () => {
    // On /settings the first section is not a SIBLING of the page header — it
    // is the first child of the <form> that follows it — so the adjacent
    // sibling rule above never matched and Settings opened with a divider
    // immediately under its H1 (#295 review). The wrapper form of the rule is
    // (0,3,0), so it also outranks `.samograph-settings-section`'s own
    // `border-top`, which is what actually drew that line.
    const wrapped = rule(".samograph-page-header + * > .samograph-section:first-child");
    expect(wrapped).toContain("border-top: 0");
    expect(wrapped).toContain("padding-top: 0");
  });

  it("draws exactly ONE hairline between two adjacent sections", () => {
    // A list row's `border-top` separates rows; the LAST row also having a
    // `border-bottom` put a second hairline 24px above the next section's own
    // `border-top` (and above `.samograph-danger-zone`'s 2px --crit rule) —
    // two lines where the design model has one (#295 review, DESIGN-MODEL §4
    // "Hairlines, not boxes").
    expect(rule(".samograph-call-item")).toContain("border-top: 1px solid var(--line)");
    expect(rule(".samograph-call-item:last-child")).toBe("");
    expect(rule(".samograph-meeting-item:last-child")).toBe("");
    expect(css).not.toMatch(/\.samograph-(?:call|meeting)-item:last-child[^{]*\{[^}]*border-bottom/);
  });

  it("groups a section title with its description on the tighter gap", () => {
    const header = rule(".samograph-section-header");
    expect(header).toContain("gap: var(--space-1)");
    expect(header).toContain("margin-bottom: var(--space-4)");
    const description = rule(".samograph-section-description");
    expect(description).toContain("color: var(--muted)");
    expect(description).toContain("font-size: var(--text-sm)");
  });

  it("keeps the dashboard's peer sections on the one rhythm", () => {
    // `.samograph-dash-hero` and `.samograph-upcoming-meetings` are the two
    // dashboard sections whose markup lives in other components; they join the
    // shared rule rather than keeping private `margin-block` values.
    for (const selector of [".samograph-dash-hero", ".samograph-upcoming-meetings"]) {
      expect(rule(selector)).toContain("padding-block: var(--space-6)");
      expect(rule(selector)).toContain("border-top: var(--border) solid var(--line)");
      // The private margins are what made four sections sit at four spacings.
      expect(rule(selector)).not.toContain("margin-block");
    }
  });

  it("stops double-capping the settings sections at --width-prose", () => {
    // PR 4 (#287) moved the reading measure onto the page's content column
    // (`.samograph-page--prose > * { max-width: var(--content-max) }`), so the
    // per-section cap is dead weight — flagged in the #287 review.
    expect(rule(".samograph-page--prose > *")).toContain(
      "max-width: var(--content-max)",
    );
    expect(rule(".samograph-settings-section")).not.toContain("max-width");
  });

  it("keeps the settings divider drawn with the width token (Slice 5 guard)", () => {
    expect(rule(".samograph-settings-section")).toContain(
      "border-top: var(--border-strong) solid var(--line-strong)",
    );
  });
});
