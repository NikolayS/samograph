import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The app shell has a real mobile nav (mobile audit M2).
 *
 * Before: the only responsive rule was `flex-wrap: wrap` on
 * `.samograph-app-nav-inner`, which produced a **129px** header at 390px —
 * 15% of an 844px screen, on every page — with "Signed in as alex@postgres.ai"
 * wrapping to three lines mid-token and a 154px theme switcher owning 44% of
 * the content box.
 *
 * After: the shell is mobile-first. Below `768px` the header is brand + a
 * 44x44 disclosure and nothing else (<= 56px); the links, the account line and
 * the theme control sit in the disclosure panel. At `>= 768px` the panel is
 * `display: contents`, so the desktop row is byte-for-byte the layout it was.
 *
 * This guard fails if the collapsed header grows back or the email is allowed
 * to wrap again.
 */
const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/** Every `@media` block with this query, concatenated (the stylesheet has more
 *  than one block per breakpoint). */
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

const mobile = block("(max-width: 767.98px)");
const desktop = block("(min-width: 768px)");

describe("the collapsed mobile shell", () => {
  it("caps the resting header at 56px, not 129", () => {
    const inner = rule(".samograph-app-nav-inner");
    expect(inner).toMatch(/min-height\s*:\s*56px/);
    // No block padding on mobile: 44px disclosure + padding must not exceed 56.
    expect(inner).toMatch(/padding\s*:\s*0\s+var\(--gutter\)/);
  });

  it("drops the old wrap-and-hope patch", () => {
    // `flex-wrap: wrap` on the inner row is what stacked the header into three
    // rows; the only wrapping left is the menu's own full-width flex-basis.
    expect(block("(max-width: 40rem)")).not.toMatch(/samograph-app-nav-inner|samograph-app-nav-right/);
  });

  it("holds the bar at 56px so opening the panel does not shift the brand", () => {
    expect(rule(".samograph-app-brand", mobile)).toMatch(/min-height\s*:\s*56px/);
  });

  it("gives the disclosure a full 44px touch target", () => {
    const toggle = rule(".samograph-app-nav-toggle");
    expect(toggle).toMatch(/width\s*:\s*var\(--control-h\)/);
    expect(toggle).toMatch(/height\s*:\s*var\(--control-h\)/);
    expect(toggle).toMatch(/margin-left\s*:\s*auto/);
  });

  it("stacks the panel under the header when it is open, and collapses it when not", () => {
    const menu = rule(".samograph-app-nav-menu", mobile);
    expect(menu).toMatch(/display\s*:\s*flex/);
    expect(menu).toMatch(/flex-direction\s*:\s*column/);
    expect(menu).toMatch(/flex-basis\s*:\s*100%/);
    // `display: none` rather than the `hidden` attribute — see the CSS comment.
    expect(rule('.samograph-app-nav-menu[data-open="false"]', mobile)).toMatch(/display\s*:\s*none/);
  });

  it("makes every link in the panel a 44px tap target", () => {
    expect(rule(".samograph-app-nav-menu .samograph-app-nav-links a", mobile)).toMatch(
      /min-height\s*:\s*var\(--control-h\)/,
    );
  });

  it("ellipsises the account address instead of wrapping it mid-token", () => {
    const email = rule(".samograph-app-nav-menu :is(.samograph-account-email)", mobile);
    expect(email).toMatch(/white-space\s*:\s*nowrap/);
    expect(email).toMatch(/overflow\s*:\s*hidden/);
    expect(email).toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(email).toMatch(/overflow-wrap\s*:\s*normal/);
  });
});

describe("the desktop row is unchanged at >= 768px", () => {
  it("restores the 64px bar and its block padding", () => {
    const inner = rule(".samograph-app-nav-inner", desktop);
    expect(inner).toMatch(/min-height\s*:\s*64px/);
    expect(inner).toMatch(/padding\s*:\s*var\(--space-2\)\s+var\(--gutter\)/);
  });

  it("dissolves the panel back into the header row and hides the disclosure", () => {
    expect(rule(".samograph-app-nav-menu[data-open]", desktop)).toMatch(/display\s*:\s*contents/);
    expect(rule(".samograph-app-nav-toggle", desktop)).toMatch(/display\s*:\s*none/);
  });

  it("leaves the panel's own layout below the breakpoint, never above it", () => {
    // Regression: these lived in the base layer once and stacked the DESKTOP
    // links into a column (header 67px -> 113px at 1024).
    expect(desktop).not.toMatch(/flex-direction\s*:\s*column/);
    expect(mobile).toMatch(/\.samograph-app-nav-menu\s+\.samograph-app-nav-links/);
  });

  it("keeps the right-hand group pushed to the end", () => {
    expect(rule(".samograph-app-nav-right", desktop)).toMatch(/margin-left\s*:\s*auto/);
  });
});
