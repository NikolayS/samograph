import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Refined design-token contract (issue #241).
 *
 * `apps/web/app/globals.css` is the single source of truth for the "Greenroom"
 * palette. This test locks the contract that future visual changes touch ONE
 * file: every color must be delivered through a CSS custom property, the palette
 * must be defined once in `:root`, and it must theme in BOTH directions
 * (`prefers-color-scheme` AND an explicit `data-theme` override).
 *
 * DOM-free: it reads the CSS as text and asserts its structure — no renderer.
 */

const CSS = readFileSync(join(import.meta.dir, "..", "app", "globals.css"), "utf8");
// Comments may legitimately mention hex values / token names in prose; strip
// them so neither the token-presence nor the no-raw-hex scan trips on prose.
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Return the body of the FIRST base `:root { … }` block (the token registry).
 * `[^}]*` stops at the first `}` — the base block has no nested braces — and the
 * `\s*\{` guard means `:root[data-theme=…]` selectors are NOT matched here.
 */
function baseRootBody(): string {
  return CSS_NO_COMMENTS.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
}

/** Body of a flat (`[^}]*`, no nested braces) selector block, or "" if absent. */
function flatBlockBody(selectorRegex: string): string {
  return CSS_NO_COMMENTS.match(new RegExp(`${selectorRegex}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

/**
 * Body of a brace-nested at-rule/selector block (depth-matched), or "" if absent.
 * Needed for `@media (prefers-color-scheme: dark) { :root { … } }`.
 */
function nestedBlockBody(marker: string): string {
  const start = CSS_NO_COMMENTS.indexOf(marker);
  if (start === -1) return "";
  const open = CSS_NO_COMMENTS.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < CSS_NO_COMMENTS.length; i++) {
    const ch = CSS_NO_COMMENTS[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return CSS_NO_COMMENTS.slice(open + 1, i);
    }
  }
  return "";
}

/** True if `body` declares the custom property `--name` (as `--name:`). */
function declares(body: string, name: string): boolean {
  return new RegExp(`--${name}\\s*:`).test(body);
}

/** The declared value of `--name` in `body`, trimmed, or "" when absent. */
function valueOf(body: string, name: string): string {
  return body.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? "";
}

const CORE_TOKENS = [
  "ground",
  "surface",
  "ink",
  "ink-soft",
  "muted",
  "faint",
  "line",
  "line-strong",
  "panel-ground",
  "panel-surface",
  "panel-strip",
  "panel-ink",
  "panel-muted",
  "panel-line",
  "panel-gutter",
  "accent-live",
  "signal",
  "green",
  "green-deep",
  "green-soft",
  "pink",
  "pink-soft",
  "good",
  "warn",
  "crit",
  "on-green",
  "on-pink",
  "font-body",
  "font-display",
  "font-mono",
];

// The status chip (`.samograph-status[data-status-kind]`) draws from a per-kind
// token; the kinds come from callStatusView.ts `StatusKind`.
const STATE_TOKENS = [
  "state-pending",
  "state-joining",
  "state-live",
  "state-ended",
  "state-error",
];

describe("Refined design tokens — globals.css contract (issue #241)", () => {
  describe("Slice 2 controls and feedback primitives", () => {
    it("does not give every bare button or label a margin-top", () => {
      expect(/(?:^|\})\s*button\s*\{[^}]*margin-top\s*:/m.test(CSS_NO_COMMENTS)).toBe(false);
      expect(/(?:^|\})\s*label\s*\{[^}]*margin-top\s*:/m.test(CSS_NO_COMMENTS)).toBe(false);
    });

    for (const selector of [
      ".samograph-btn", ".samograph-btn--primary", ".samograph-btn--secondary",
      ".samograph-btn--danger", ".samograph-btn[disabled]",
      '.samograph-btn[aria-busy="true"]', ".samograph-alert",
      ".samograph-alert--error", ".samograph-alert--warn",
      ".samograph-alert--success", ".samograph-alert--info", ".samograph-field",
      ".samograph-field-hint", ".samograph-actions",
    ]) {
      it(`defines ${selector}`, () => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(new RegExp(`${escaped}\\s*\\{`).test(CSS_NO_COMMENTS)).toBe(true);
      });
    }

    it("uses the mono font for textarea controls", () => {
      expect(/textarea\s*\{[^}]*font-family\s*:\s*var\(--font-mono\)/m.test(CSS_NO_COMMENTS)).toBe(true);
    });

    it("has no bare role=alert selector", () => {
      expect(/\[role=["']?alert["']?\]\s*\{/.test(CSS_NO_COMMENTS)).toBe(false);
    });

    it("defines a filled danger button modifier", () => {
      // Design PR 7 wrapped the `--solid` half in `:where()` so the modifier
      // stays at single-class specificity and the `.samograph-btn[disabled]`
      // recipe still outranks it. Same selector, same match, lower weight.
      expect(/\.samograph-btn--danger:where\(\.samograph-btn--solid\)\s*\{/.test(CSS_NO_COMMENTS)).toBe(true);
    });

    it("styles every JSX role=alert as a samograph error alert", () => {
      const roots = [join(import.meta.dir, "..", "components"), join(import.meta.dir, "..", "app")];
      const files: string[] = [];
      const visit = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) files.push(path);
        }
      };
      roots.forEach(visit);
      const offenders = files.flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(/<[^>]*role=["']alert["'][^>]*>/gs)]
          .filter(([tag]) => !/className=["'][^"']*samograph-alert--error[^"']*["']/.test(tag))
          .map(() => file);
      });
      expect(offenders).toEqual([]);
    });
  });

  describe("(a) :root defines the full Refined token set", () => {
    const root = baseRootBody();

    it("finds a base :root token block", () => {
      expect(root.length).toBeGreaterThan(0);
    });

    for (const t of CORE_TOKENS) {
      it(`defines --${t} in :root`, () => {
        expect(declares(root, t)).toBe(true);
      });
    }

    for (const t of STATE_TOKENS) {
      it(`defines --${t} in :root (per-kind status token)`, () => {
        expect(declares(root, t)).toBe(true);
      });
    }

    it("keeps color-scheme declared in :root", () => {
      expect(/color-scheme\s*:/.test(root)).toBe(true);
    });
  });

  describe("(b) matches the approved mockup palette", () => {
    const LIGHT = {
      ground: "#f4f2ed", surface: "#faf9f6", ink: "#14130f",
      "ink-soft": "#3a382f", muted: "#6b675c", faint: "#9c978a",
      line: "#dfdbd1", "line-strong": "#b9b4a6",
    };
    const DARK = {
      ground: "#111110", surface: "#191918", ink: "#edeae2",
      "ink-soft": "#c6c2b7", muted: "#918c80", faint: "#6a665d",
      line: "#3a3934", "line-strong": "#45433d",
    };
    const INSTRUMENT = {
      "panel-ground": "#0c0c0b", "panel-surface": "#141413",
      "panel-strip": "#1c1b18", "panel-ink": "#e2dfd7",
      "panel-muted": "#837f76", "panel-line": "#24231f",
      "panel-gutter": "#4a4842", "accent-live": "#4ed18a",
      signal: "#ff4fb0",
    };

    it("uses exact light values in base :root and explicit light", () => {
      const explicit = flatBlockBody(':root\\[data-theme="light"\\]');
      for (const [token, value] of Object.entries(LIGHT)) {
        expect(valueOf(baseRootBody(), token)).toBe(value);
        expect(valueOf(explicit, token)).toBe(value);
      }
    });

    it("uses exact dark values for OS preference and explicit dark", () => {
      const media = nestedBlockBody("@media (prefers-color-scheme: dark)");
      const explicit = flatBlockBody(':root\\[data-theme="dark"\\]');
      for (const [token, value] of Object.entries(DARK)) {
        expect(valueOf(media, token)).toBe(value);
        expect(valueOf(explicit, token)).toBe(value);
      }
    });

    it("keeps instrument, live, and one-element signal tokens invariant", () => {
      for (const [token, value] of Object.entries(INSTRUMENT)) {
        expect(valueOf(baseRootBody(), token)).toBe(value);
      }
      // One compatibility alias declaration plus the streaming caret, now drawn
      // once — only the real transcript (Slice 3); the landing no longer fakes
      // an instrument. The signal magenta stays a ONE-ELEMENT accent.
      expect(CSS_NO_COMMENTS.match(/var\(--signal\)/g)?.length ?? 0).toBe(2);
      expect(CSS_NO_COMMENTS.match(/background: var\(--signal\)/g)?.length ?? 0).toBe(1);
    });

    it("uses the Slice 1 dual sans/mono font roles", () => {
      const root = baseRootBody();
      expect(valueOf(root, "font-sans")).toContain('"Inter"');
      expect(valueOf(root, "font-mono")).toContain('"JetBrains Mono"');
      expect(valueOf(root, "font-body")).toBe("var(--font-sans)");
      expect(valueOf(root, "font-display")).toBe("var(--font-sans)");
    });
  });

  describe("(c) themes in BOTH directions, each redefining --ground and --ink", () => {
    it("has a @media (prefers-color-scheme: dark) block redefining --ground and --ink", () => {
      expect(CSS_NO_COMMENTS).toContain("@media (prefers-color-scheme: dark)");
      const media = nestedBlockBody("@media (prefers-color-scheme: dark)");
      expect(declares(media, "ground")).toBe(true);
      expect(declares(media, "ink")).toBe(true);
    });

    it('has :root[data-theme="dark"] redefining --ground and --ink', () => {
      const dark = flatBlockBody(':root\\[data-theme="dark"\\]');
      expect(dark.length).toBeGreaterThan(0);
      expect(declares(dark, "ground")).toBe(true);
      expect(declares(dark, "ink")).toBe(true);
    });

    it('has :root[data-theme="light"] redefining --ground and --ink', () => {
      const light = flatBlockBody(':root\\[data-theme="light"\\]');
      expect(light.length).toBeGreaterThan(0);
      expect(declares(light, "ground")).toBe(true);
      expect(declares(light, "ink")).toBe(true);
    });
  });

  describe("(d) no raw hex in a non-token declaration value — every color via var()", () => {
    // Match `property: value;` declarations. `[\w-]+` captures custom properties
    // (`--x`) and standard ones alike; `[^;{}]+` cannot cross a rule boundary, so
    // selectors and media features (no terminating `;`) are never captured.
    const DECL = /([\w-]+)\s*:\s*([^;{}]+);/g;
    const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

    it("every hex color lives ONLY in a --custom-property (token) declaration", () => {
      const offenders: string[] = [];
      for (const m of CSS_NO_COMMENTS.matchAll(DECL)) {
        const [, prop, value] = m;
        if (prop.startsWith("--")) continue; // token definition — hex allowed here
        if (HEX.test(value)) offenders.push(`${prop}: ${value.trim()}`);
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("landing link touch targets", () => {
    for (const selector of [
      "\\.samograph-site-footer nav a",
      "\\.samograph-brand",
    ]) {
      it(`gives ${selector} a 44px minimum touch target`, () => {
        const rule = flatBlockBody(selector);
        expect(rule.length).toBeGreaterThan(0);
        expect(/display\s*:\s*inline-flex\s*;/.test(rule)).toBe(true);
        expect(/align-items\s*:\s*center\s*;/.test(rule)).toBe(true);
        expect(/justify-content\s*:\s*center\s*;/.test(rule)).toBe(true);
        expect(/min-width\s*:\s*44px\s*;/.test(rule)).toBe(true);
        expect(/min-height\s*:\s*44px\s*;/.test(rule)).toBe(true);
      });
    }
  });

  /**
   * (d) "Continue with Google" chrome (issue #209, PR 6).
   *
   * These are Google's OWN approved colour sets, not Greenroom hues — but they
   * still go through the token mechanism, both so the no-raw-hex rule above holds
   * and so light/dark switch through the same machinery as everything else.
   * The exact values are a condition of using the mark, so they are asserted
   * literally: a redesign that retunes them is a branding violation, not a taste
   * change, and must fail here rather than ship.
   *
   * Light: #ffffff surface / #747775 border / #1f1f1f label.
   * Dark:  #131314 surface / #8e918f border / #e3e3e3 label.
   */
  describe("(d) Google button chrome themes in both directions (#209)", () => {
    const GOOGLE_TOKENS = ["google-btn-bg", "google-btn-border", "google-btn-ink"];
    const LIGHT = { bg: "#ffffff", border: "#747775", ink: "#1f1f1f" };
    const DARK = { bg: "#131314", border: "#8e918f", ink: "#e3e3e3" };

    it("declares Google's LIGHT colour set in the base :root", () => {
      const root = baseRootBody();
      for (const t of GOOGLE_TOKENS) expect(declares(root, t)).toBe(true);
      expect(valueOf(root, "google-btn-bg")).toBe(LIGHT.bg);
      expect(valueOf(root, "google-btn-border")).toBe(LIGHT.border);
      expect(valueOf(root, "google-btn-ink")).toBe(LIGHT.ink);
    });

    it("declares Google's DARK colour set under prefers-color-scheme: dark", () => {
      const media = nestedBlockBody("@media (prefers-color-scheme: dark)");
      expect(valueOf(media, "google-btn-bg")).toBe(DARK.bg);
      expect(valueOf(media, "google-btn-border")).toBe(DARK.border);
      expect(valueOf(media, "google-btn-ink")).toBe(DARK.ink);
    });

    it('declares Google\'s DARK colour set under :root[data-theme="dark"]', () => {
      const dark = flatBlockBody(':root\\[data-theme="dark"\\]');
      expect(valueOf(dark, "google-btn-bg")).toBe(DARK.bg);
      expect(valueOf(dark, "google-btn-border")).toBe(DARK.border);
      expect(valueOf(dark, "google-btn-ink")).toBe(DARK.ink);
    });

    it('declares Google\'s LIGHT colour set under :root[data-theme="light"]', () => {
      const light = flatBlockBody(':root\\[data-theme="light"\\]');
      expect(valueOf(light, "google-btn-bg")).toBe(LIGHT.bg);
      expect(valueOf(light, "google-btn-border")).toBe(LIGHT.border);
      expect(valueOf(light, "google-btn-ink")).toBe(LIGHT.ink);
    });

    it("clears Google's 40px height minimum and keeps its 4px radius", () => {
      const rule = flatBlockBody("\\.samograph-google-signin");
      expect(rule.length).toBeGreaterThan(0);
      // Google states 40px as a MINIMUM, not a fixed height, so the button
      // takes the app's control height (--control-h: 44px, asserted in
      // test/control-height.test.ts) instead of standing 4px short of every
      // other control on the page. The radius IS fixed by the guidelines.
      expect(/min-height\s*:\s*var\(--control-h\)\s*;/.test(rule)).toBe(true);
      const controlHeight = Number(
        /--control-h\s*:\s*(\d+)px/.exec(flatBlockBody(":root"))?.[1] ?? "0",
      );
      expect(controlHeight).toBeGreaterThanOrEqual(40);
      expect(/border-radius\s*:\s*4px\s*;/.test(rule)).toBe(true);
      // Chrome comes from the tokens above — never a raw hex, never a Greenroom hue.
      expect(rule).toContain("var(--google-btn-bg)");
      expect(rule).toContain("var(--google-btn-border)");
      expect(rule).toContain("var(--google-btn-ink)");
    });
  });
});

/**
 * Slice 5 — Auth + Settings. `--border-strong` is a *width* token (2px); using it
 * where a colour belongs makes the whole `border-top` declaration invalid at
 * parse time, so the Settings section rules and the sticky save bar draw nothing.
 */
describe("Slice 5 — Settings section rules and save bar", () => {
  for (const selector of ["\\.samograph-settings-section", "\\.samograph-savebar"]) {
    it(`${selector.replace(/\\/g, "")} draws its rule with the width token and a line colour`, () => {
      const rule = flatBlockBody(selector);
      expect(rule.length).toBeGreaterThan(0);
      expect(rule).toContain("border-top: var(--border-strong) solid var(--line-strong);");
      // A width token can never be a colour — `1px solid 2px` is an invalid declaration.
      expect(/solid\s+var\(--border-strong\)/.test(rule)).toBe(false);
    });
  }

  // PLAN.md PR 4: the reading width still comes from `--width-prose`, but it
  // now caps the CONTENT column (`--content-max`) rather than `<main>`, which
  // stays on the shared page container so it aligns with the nav.
  it("gives the settings route a --width-prose content column so the section blocks can breathe", () => {
    const rule = flatBlockBody("\\.samograph-page--prose");
    expect(rule).toContain("--content-max: var(--width-prose);");
    const route = readFileSync(join(import.meta.dir, "..", "app", "settings", "page.tsx"), "utf8");
    expect(route).toContain('pageClassName="samograph-page--prose"');
    expect(route).not.toContain('pageClassName="samograph-page--form"');
  });

  it("varies the three visible skeleton bars, not the visually-hidden label", () => {
    // `.samograph-visually-hidden` is span nth-of-type(1); the bars are 2..4.
    expect(CSS).toContain('.samograph-skeleton > span[aria-hidden="true"]:nth-of-type(3) { width: 70%; }');
    expect(CSS).toContain('.samograph-skeleton > span[aria-hidden="true"]:nth-of-type(4) { width: 85%; }');
  });
});
