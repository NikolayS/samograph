import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Form fields are iOS-safe and one geometry (mobile audit M8, `docs/design`
 * AUDIT-2026-09-04 §6 `/auth` + "Forms on mobile").
 *
 * Before: every field inherited `--text-base` (14px). **iOS Safari zooms the
 * page whenever a focused input's text is under 16px** — and it never zooms
 * back out, so the rest of the form is then off-screen. `--field-max` (22rem =
 * 352px) also capped `.samograph-select` at EVERY width, including the 350px
 * mobile content box where a capped field reads as a broken one. On `/auth`
 * the magic-link input, its submit and "Continue with Google" were three
 * different widths in one 480px column.
 *
 * After: below `768px` the shared field selector is 16px and `--field-max`
 * does not apply; on `/auth` the three controls share the 44px control recipe
 * at full column width.
 *
 * This guard fails if the 16px floor, the desktop-only cap, or the single
 * auth geometry regresses.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/** Every `@media` block with this query, concatenated. */
function block(query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const found: string[] = [];
  for (const match of css.matchAll(new RegExp(`@media\\s*${escaped}`, "g"))) {
    let depth = 0;
    for (let i = css.indexOf("{", match.index!); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(css.slice(match.index!, i + 1));
          break;
        }
      }
    }
  }
  return found.join("\n");
}

function rule(selector: string, scope = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return normalize(scope.match(new RegExp(`(?:^|[};{])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "");
}

/** The base stylesheet with every `@media` block removed. */
const unconditional = (() => {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf("{", at);
    for (; j < css.length; j += 1) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
})();

const mobile = block("(max-width: 767.98px)");
const desktop = block("(min-width: 768px)");

/** The shared field selector introduced by PR #279 — matched as written. */
const FIELD_SELECTOR = 'input:where(:not([type="checkbox"], [type="radio"])), select, textarea';

/** The `@media (max-width: 767.98px)` rule that starts at the shared field
 *  selector, split into its selector list and its declarations. */
const fieldFontRule = (() => {
  const start = mobile.indexOf("input:where");
  if (start === -1) return { selectors: "", declarations: "" };
  const open = mobile.indexOf("{", start);
  const close = mobile.indexOf("}", open);
  return {
    selectors: normalize(mobile.slice(start, open)),
    declarations: normalize(mobile.slice(open + 1, close)),
  };
})();

describe("iOS zoom-on-focus", () => {
  it("raises every text field to 16px below --bp-md", () => {
    // 16px is the iOS threshold exactly: at 15.99px Safari zooms.
    expect(fieldFontRule.declarations).toMatch(/font-size\s*:\s*16px/);
  });

  it("covers the styled select wrapper's own select too", () => {
    // `.samograph-select > select` sets `font: inherit` — a shorthand, so it
    // re-resets font-size — at the same (0,1,1) specificity and LATER in the
    // file. A media query adds no specificity, so the styled select needs its
    // own 16px rule after that one, or it stays at 14px and keeps zooming.
    expect(rule(".samograph-select > select", mobile)).toMatch(/font-size\s*:\s*16px/);
    expect(rule(".samograph-select > select", unconditional)).not.toMatch(/font-size/);
  });

  it("orders the select's 16px rule after the `font: inherit` it must beat", () => {
    const inherit = css.indexOf("font: inherit");
    const override = css.search(/@media\s*\(max-width:\s*767\.98px\)\s*\{\s*\.samograph-select\s*>\s*select/);
    expect(inherit).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(inherit);
  });

  it("keeps the field font on the type scale at >= 768px", () => {
    // No 16px override up here: the field inherits --text-base like every
    // other control, so the desktop type scale is untouched.
    expect(rule(FIELD_SELECTOR, desktop)).not.toMatch(/font-size/);
    expect(rule(FIELD_SELECTOR, unconditional)).not.toMatch(/font-size/);
  });
});

describe("--field-max is a desktop cap", () => {
  it("does not cap the select on a phone", () => {
    expect(rule(".samograph-select", unconditional)).not.toMatch(/max-width/);
    expect(rule(".samograph-select", mobile)).not.toMatch(/max-width\s*:\s*var\(--field-max\)/);
  });

  it("still caps it at >= 768px", () => {
    expect(rule(".samograph-select", desktop)).toMatch(/max-width\s*:\s*var\(--field-max\)/);
  });
});

describe("/auth is one field geometry", () => {
  it("gives the magic-link submit the field's full width", () => {
    expect(rule(".samograph-auth-form > .samograph-btn")).toMatch(/width\s*:\s*100%/);
  });

  it("keeps Google's button on the same 44px full-width recipe", () => {
    // Google's guidelines fix a 40px MINIMUM and a 4px radius; --control-h
    // (44px) clears the minimum, so the three controls line up without
    // breaking branding. Do not tokenise the radius.
    const google = rule(".samograph-google-signin");
    expect(google).toMatch(/min-height\s*:\s*var\(--control-h\)/);
    expect(google).toMatch(/width\s*:\s*100%/);
  });

  it("stacks the auth form as one column", () => {
    expect(rule(".samograph-auth-form")).toMatch(/display\s*:\s*block/);
  });
});

describe("the public shell's theme control", () => {
  it("rides inline in the bar instead of behind a disclosure", () => {
    // /auth, /auth/callback and /c/<token> have no menu: a hamburger over a
    // single theme switcher is a disclosure that discloses nothing.
    expect(rule(".samograph-app-nav-inner > .samograph-app-nav-right")).toMatch(/margin-left\s*:\s*auto/);
  });
});
