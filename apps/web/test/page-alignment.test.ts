import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Page container + action rows (design audit AUDIT-2026-09-04 §3 and §4,
 * PLAN.md desktop PR 3 + PR 4, DESIGN-MODEL §5 "Desktop shell" / §4 Button).
 *
 * §3 — the nav inner box was capped at `--width-app` (1120) and `<main>` at
 * `--width-prose` (720), each centred INDEPENDENTLY, so the wordmark and the
 * settings H1 sat 200px apart at 1200px (150px at 1024px). The fix is ONE page
 * container — `--page-max` + `--gutter` — used by the nav inner AND by
 * `.samograph-page`, with the narrower reading width moved off the page and
 * onto the content column as `--content-max`.
 *
 * §4 — `.samograph-signin` is `display: grid`, and the calendar card reused
 * that class, so the Reconnect/Disconnect pair became two 656px-wide stacked
 * grid items. Button pairs now sit in `.samograph-actions`: a wrapping flex
 * row whose children keep their intrinsic width (DESIGN-MODEL §4: a button
 * "never stretches").
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return normalize(css.match(new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "");
}

const token = (name: string) => normalize(root.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1] ?? "");

describe("one page container for the nav and the page", () => {
  it("defines --page-max in :root", () => {
    expect(token("--page-max")).toBe("var(--width-app)");
  });

  it("gives <main> and the nav inner the SAME max-width and gutter", () => {
    const page = rule(".samograph-page");
    const nav = rule(".samograph-app-nav-inner");
    expect(page).toContain("max-width: var(--page-max)");
    expect(nav).toContain("max-width: var(--page-max)");
    expect(page).toMatch(/padding:[^;]*var\(--gutter\)/);
    expect(nav).toMatch(/padding:[^;]*var\(--gutter\)/);
    expect(page).toContain("margin: 0 auto");
    expect(nav).toContain("margin: 0 auto");
  });

  it("never re-centres <main> for --prose / --form", () => {
    expect(rule(".samograph-page--prose")).not.toMatch(/(?:^|[;\s])max-width\s*:/);
    expect(rule(".samograph-page--form")).not.toMatch(/(?:^|[;\s])max-width\s*:/);
  });

  it("constrains the content column instead, via --content-max", () => {
    expect(rule(".samograph-page--prose")).toContain("--content-max: var(--width-prose)");
    expect(rule(".samograph-page--form")).toContain("--content-max: var(--width-form)");
    expect(rule(".samograph-page--prose > *, .samograph-page--form > *")).toContain("max-width: var(--content-max)");
  });
});

describe("action rows keep buttons at their intrinsic width", () => {
  // `.samograph-actions` predates this PR (InlineConfirm, MagicLinkRequestForm).
  // A second rule elsewhere in the sheet does not "extend" the first — it wins
  // or loses on source order, declaration by declaration, and a guard that
  // reads only the FIRST match cannot see the difference. So: exactly one rule,
  // and the assertions below are the whole of it.
  it("declares .samograph-actions exactly once", () => {
    // Anchored on the start of a selector (`}` / `;` / start of file) so a
    // scoped override like `.samograph-calendar-card > .samograph-actions`
    // does not count as a second base rule.
    expect([...css.matchAll(/(?:^|[};])\s*\.samograph-actions\s*\{/g)]).toHaveLength(1);
  });

  it("lays .samograph-actions out as a wrapping flex row", () => {
    const actions = rule(".samograph-actions");
    expect(actions).toContain("display: flex");
    expect(actions).toContain("flex-wrap: wrap");
    // The gap and the top margin the pre-existing consumers already had —
    // consolidating the rule must not move InlineConfirm or the magic-link form.
    expect(actions).toContain("gap: var(--space-2)");
    expect(actions).toContain("margin-top: var(--space-5)");
  });

  // …and the top margin is page rhythm, not part of an action row: inside the
  // calendar card the grid `gap` already owns the spacing, so it is dropped
  // rather than added to.
  it("drops the row's top margin inside the calendar card's grid", () => {
    expect(rule(".samograph-calendar-card > .samograph-actions")).toContain("margin-top: 0");
  });

  it("stops action-row children from stretching", () => {
    expect(rule(".samograph-actions > *")).toContain("flex: 0 0 auto");
  });

  it("gives the calendar card its own layout instead of reusing .samograph-signin", () => {
    expect(rule(".samograph-calendar-card")).toContain("display: grid");
    const card = readFileSync(join(import.meta.dir, "../components/CalendarConnectionCard.tsx"), "utf8");
    expect(card).not.toContain("samograph-signin");
    expect(card).toContain("samograph-actions");
  });
});

/**
 * `<main>` no longer re-centres itself for `--form`, so anything that used to
 * be centred BY the page has to centre itself. The `/auth` Suspense fallback
 * (`.samograph-skeleton--form`) capped its width but never centred, so the
 * placeholder sat at the page's left edge and the loaded card jumped ~270px
 * right at 1024px.
 */
describe("the form skeleton sits where the form it replaces sits", () => {
  it("centres .samograph-skeleton--form in the page", () => {
    const skeleton = rule(".samograph-skeleton--form");
    expect(skeleton).toContain("max-width: var(--width-form)");
    expect(skeleton).toContain("margin-inline: auto");
  });
});
