import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Greenroom design-token contract (issue #178).
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

const CORE_TOKENS = [
  "ground",
  "surface",
  "ink",
  "muted",
  "line",
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

describe("Greenroom design tokens — globals.css contract (issue #178)", () => {
  describe("(a) :root defines the full Greenroom token set", () => {
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

  describe("(b) themes in BOTH directions, each redefining --ground and --ink", () => {
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

  describe("(c) no raw hex in a non-token declaration value — every color via var()", () => {
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
});
