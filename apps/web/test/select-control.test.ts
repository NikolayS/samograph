import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The native `<select>` had NO styling of its own (design audit, PR 1): it fell
 * through to the shared `input, select, textarea` rule, so the UA chevron drew
 * itself ~640px from the value in a 656px-wide box whose 37px height matched
 * neither the 36px button nor the 40px input.
 *
 * `.samograph-select` is the fix: `appearance: none`, a full-height bordered
 * end-cap drawn with a `mask-image` so the chevron takes a token colour in both
 * themes, and `max-width: var(--field-max)` so a 4-character enum stops
 * spanning the column. These are the load-bearing declarations; this guard
 * keeps them from silently regressing.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return normalize(css.match(new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "");
}

describe("control geometry tokens", () => {
  it("defines the single answer to \"how tall is a control?\"", () => {
    expect(normalize(root.match(/--control-h\s*:\s*([^;]+);/)?.[1] ?? "")).toBe("44px");
  });

  it("defines one radius for every interactive box", () => {
    expect(normalize(root.match(/--radius-control\s*:\s*([^;]+);/)?.[1] ?? "")).toBe("var(--radius-md)");
  });

  it("defines the cap that stops a short field spanning its column", () => {
    expect(normalize(root.match(/--field-max\s*:\s*([^;]+);/)?.[1] ?? "")).toBe("22rem");
  });
});

describe(".samograph-select", () => {
  it("does not cap the wrapper unconditionally", () => {
    // The `max-width: var(--field-max)` cap moved into
    // `@media (min-width: 768px)` (mobile audit M8): on a 350px phone column a
    // 22rem cap makes a field look broken, not tidy. `test/mobile-fields.test.ts`
    // owns both halves of that contract — the cap is still there at >= 768px.
    expect(rule(".samograph-select")).not.toMatch(/max-width/);
    expect(rule(".samograph-select")).toMatch(/width\s*:\s*100%/);
  });

  it("drops the UA appearance so the chevron is ours", () => {
    const select = rule(".samograph-select > select");
    expect(select).toMatch(/(^|[;\s])appearance\s*:\s*none/);
    expect(select).toMatch(/-webkit-appearance\s*:\s*none/);
  });

  it("gives the select the shared control height and radius", () => {
    const select = rule(".samograph-select > select");
    expect(select).toMatch(/height\s*:\s*var\(--control-h\)/);
    expect(select).toMatch(/border-radius\s*:\s*var\(--radius-control\)/);
  });

  it("reserves the end-cap's width as right padding so text never runs under it", () => {
    expect(rule(".samograph-select > select")).toMatch(/padding\s*:[^;]*calc\(var\(--control-h\)/);
  });

  it("draws the end-cap as a non-interactive pseudo-element", () => {
    const cap = rule(".samograph-select::before");
    expect(cap).toMatch(/content\s*:\s*""/);
    expect(cap).toMatch(/pointer-events\s*:\s*none/);
    expect(cap).toMatch(/border-inline-start\s*:/);
  });

  it("masks the chevron so it takes a token colour in both themes", () => {
    // The cap tint and the chevron are separate pseudo-elements on purpose: a
    // mask applies to the whole box, so masking the cap would erase its
    // hairline and fill too.
    const chevron = rule(".samograph-select::after");
    expect(chevron).toMatch(/pointer-events\s*:\s*none/);
    // A hard-coded stroke in a background-image data-URI would be wrong in dark
    // mode; a mask lets the chevron be painted with --muted.
    expect(chevron).toMatch(/-webkit-mask-image\s*:\s*url\(/);
    expect(chevron).toMatch(/(^|[;\s])mask-image\s*:\s*url\(/);
    expect(chevron).toMatch(/background(-color)?\s*:\s*var\(--muted\)/);
  });

  it("styles hover, focus and disabled consistently with inputs", () => {
    expect(rule(".samograph-select:hover > select")).toMatch(/border-color\s*:\s*var\(--ink\)/);
    const focus = rule(".samograph-select > select:focus-visible");
    expect(focus).toMatch(/outline\s*:/);
    // `.samograph-select > select` (0,1,1) sets `border` and sits AFTER the
    // shared `select:focus-visible { border-color: var(--ink) }` (also 0,1,1),
    // so it wins on source order and a focused select would keep the resting
    // --control-border that inputs drop. Restate it here.
    expect(focus).toMatch(/border-color\s*:\s*var\(--ink\)/);
    const disabled = rule(".samograph-select > select:disabled");
    expect(disabled).toMatch(/cursor\s*:\s*not-allowed/);
    expect(disabled).toMatch(/color\s*:\s*var\(--muted\)/);
  });
});
