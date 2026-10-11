import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One control height (design audit, PR 2). The app shipped SEVEN heights for
 * the same conceptual thing — `.samograph-btn` 36, inputs 40 (implicit from
 * padding), the select 44, the Google button 40, the theme switcher 44,
 * in-panel buttons 44 and `.samograph-btn--sm` 28 — so a 40px input sat beside
 * a 36px button on the dashboard hero and could never line up.
 *
 * The scale is now `--control-h` (44, default) / `--control-h-sm` (36, dense
 * rows) / `--control-h-xs` (28, reserved), applied through ONE recipe:
 * `box-sizing: border-box` + an explicit `height` + zero block padding + a
 * line-height that cannot exceed the box. That makes the height exact rather
 * than the accidental sum of font metrics and padding.
 *
 * This guard fails if any control drifts back off the scale.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return normalize(css.match(new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "");
}

const token = (name: string) => normalize(root.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1] ?? "");

describe("the control-height scale", () => {
  it("defines 44 / 36 / 28 in :root", () => {
    expect(token("--control-h")).toBe("44px");
    expect(token("--control-h-sm")).toBe("36px");
    expect(token("--control-h-xs")).toBe("28px");
  });

  it("hard-codes no other control height in the stylesheet", () => {
    // The literals the audit measured: 36/40/28 as a control height. 44px
    // survives only where it is a minimum HIT TARGET on a link or the brand,
    // not a control box, so those selectors are listed explicitly.
    const offenders = css
      .split("\n")
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => /(?:^|[;{\s])(?:min-)?height:\s*(?:36|40|28)px/.test(line));
    expect(offenders.map(([n, line]) => `${n}: ${normalize(line)}`)).toEqual([]);
  });
});

describe("one recipe, so the height is exact", () => {
  it("sizes text inputs and selects to --control-h with no block padding", () => {
    const box = rule('input:where(:not([type="checkbox"], [type="radio"])), select, textarea');
    expect(box).toMatch(/box-sizing\s*:\s*border-box/);
    expect(box).toMatch(/line-height\s*:\s*var\(--leading-tight\)/);
    const field = rule('input:where(:not([type="checkbox"], [type="radio"])), select');
    expect(field).toMatch(/height\s*:\s*var\(--control-h\)/);
    expect(field).toMatch(/padding\s*:\s*0\s+var\(--space-3\)/);
  });

  it("gives the textarea the same box with --control-h as its height unit", () => {
    const textarea = rule("textarea");
    expect(textarea).toMatch(/min-height\s*:\s*calc\(var\(--control-h\)\s*\*\s*2\)/);
  });

  it("keeps body leading in the textarea — the tight leading is for one-line boxes", () => {
    // --leading-tight (1.2) exists to pin a single-line control to an exact
    // height. A textarea wraps, so its lines must stay on the body rhythm.
    expect(rule("textarea")).toMatch(/line-height\s*:\s*var\(--leading-normal\)/);
  });

  it("keeps one radius across fields and buttons", () => {
    expect(rule('input:where(:not([type="checkbox"], [type="radio"])), select, textarea')).toMatch(
      /border-radius\s*:\s*var\(--radius-control\)/,
    );
    expect(rule(".samograph-btn")).toMatch(/border-radius\s*:\s*var\(--radius-control\)/);
  });

  it("never stretches a checkbox or radio to a control box", () => {
    // The shared field recipe must exclude them: a 44px-tall, 100%-wide
    // checkbox is what the old blanket `input` selector produced.
    expect(rule('input:where(:not([type="checkbox"], [type="radio"])), select')).not.toBe("");
    expect(rule("input, select, textarea")).toBe("");
  });
});

describe("every control is on the scale", () => {
  it("puts the button at the default height", () => {
    const btn = rule(".samograph-btn");
    expect(btn).toMatch(/box-sizing\s*:\s*border-box/);
    expect(btn).toMatch(/height\s*:\s*var\(--control-h\)/);
    expect(btn).toMatch(/line-height\s*:\s*1/);
  });

  it("puts the small button on the 36px step, not a magic 28", () => {
    expect(rule(".samograph-btn--sm")).toMatch(/height\s*:\s*var\(--control-h-sm\)/);
  });

  it("puts the Google sign-in button on the scale (44 clears Google's 40 minimum)", () => {
    expect(rule(".samograph-google-signin")).toMatch(/min-height\s*:\s*var\(--control-h\)/);
  });

  it("puts the theme switcher on the scale", () => {
    expect(rule(".samograph-theme-switcher__option")).toMatch(/min-height\s*:\s*var\(--control-h\)/);
  });

  it("puts the in-panel transcript buttons on the scale", () => {
    const panel = rule(
      ".samograph-percall .samograph-download-transcript, .samograph-percall .samograph-download-transcript-speech, .samograph-percall .samograph-toggle-chat",
    );
    expect(panel).toMatch(/min-height\s*:\s*var\(--control-h\)/);
    expect(rule(".samograph-jump-live")).toMatch(/min-height\s*:\s*var\(--control-h\)/);
  });
});

describe("the dashboard hero row", () => {
  it("centres the input and its button now that they are the same height", () => {
    const hero = rule(".samograph-dash-hero-form");
    expect(hero).toMatch(/align-items\s*:\s*center/);
    expect(hero).not.toMatch(/align-items\s*:\s*end/);
  });

  it("drops the field's label margin inside the row so the boxes align exactly", () => {
    expect(rule(".samograph-dash-hero-form input")).toMatch(/margin-top\s*:\s*0/);
  });
});
