import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Alert copy is body text, so it must clear WCAG AA (4.5:1) against the tint it
// sits on — in BOTH themes. `--accent-live` mint fails this on the light
// surface, which is why DESIGN.md keeps it inside the instrument panel.
const MIN_CONTRAST = 4.5;

const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): Record<string, string> {
  const body = css.match(new RegExp(`${selector.replace(/[[\]"^$.*+?()\\|{}]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const base = block(":root");
const themes = {
  light: { ...base, ...block(':root[data-theme="light"]') },
  dark: { ...base, ...block(':root[data-theme="dark"]') },
};

type Rgb = [number, number, number];

function resolve(value: string, tokens: Record<string, string>, depth = 0): string {
  if (depth > 8) throw new Error(`cyclic var() chain: ${value}`);
  const varRef = value.trim().match(/^var\((--[\w-]+)(?:\s*,\s*([^)]*))?\)$/);
  if (!varRef) return value.trim();
  const target = tokens[varRef[1]] ?? varRef[2];
  if (target === undefined) throw new Error(`undefined token ${varRef[1]}`);
  return resolve(target, tokens, depth + 1);
}

function hex(value: string): Rgb {
  const m = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (/^white$/i.test(value)) return [255, 255, 255];
  if (/^black$/i.test(value)) return [0, 0, 0];
  throw new Error(`unsupported color: ${value}`);
}

function color(value: string, tokens: Record<string, string>): Rgb {
  const resolved = resolve(value, tokens);
  const mix = resolved.match(/^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/);
  if (!mix) return hex(resolved);
  const a = color(mix[1], tokens);
  const b = color(mix[3], tokens);
  const p = Number(mix[2]) / 100;
  return [0, 1, 2].map((i) => Math.round(a[i] * p + b[i] * (1 - p))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const variants = [...css.matchAll(/\.samograph-alert--([\w-]+)\s*\{([^}]*)\}/g)].map(([, name, body]) => ({
  name,
  color: body.match(/(?:^|;)\s*color\s*:\s*([^;]+);/)?.[1]?.trim(),
  background: body.match(/(?:^|;)\s*background\s*:\s*([^;]+);/)?.[1]?.trim(),
}));

// The OS-preference block and the explicit-choice block must stay in lockstep,
// or a token exists in one dark path and not the other.
const mediaDark = (() => {
  const body = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
})();

describe("dark theme paths", () => {
  it("defines the same tokens whether dark comes from the OS or an explicit choice", () =>
    expect(mediaDark).toEqual(block(':root[data-theme="dark"]')));
});

describe("alert contrast", () => {
  it("styles at least the four alert variants", () =>
    expect(variants.map((v) => v.name).sort()).toEqual(["error", "info", "success", "warn"]));

  for (const variant of variants) {
    for (const theme of ["light", "dark"] as const) {
      it(`.samograph-alert--${variant.name} clears ${MIN_CONTRAST}:1 in ${theme} mode`, () => {
        expect(variant.color).toBeDefined();
        expect(variant.background).toBeDefined();
        const tokens = themes[theme];
        const ratio = contrast(color(variant.color!, tokens), color(variant.background!, tokens));
        expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(MIN_CONTRAST);
      });
    }
  }
});

// Status chips are unfilled text on the page ground, so the chip colour IS the
// text colour. `accent-live` mint is the classic failure here.
const chips = [
  { name: "default", selector: /\.samograph-status-chip\s*\{([^}]*)\}/ },
  ...["joining", "live", "ended", "error"].map((kind) => ({
    name: kind,
    selector: new RegExp(`\\.samograph-status-chip\\[data-kind="${kind}"\\]\\s*\\{([^}]*)\\}`),
  })),
];

describe("status chip contrast", () => {
  for (const chip of chips) {
    for (const theme of ["light", "dark"] as const) {
      it(`.samograph-status-chip ${chip.name} clears ${MIN_CONTRAST}:1 in ${theme} mode`, () => {
        const body = css.match(chip.selector)?.[1];
        expect(body).toBeDefined();
        const fg = body!.match(/(?:^|;)\s*color\s*:\s*([^;]+);/)?.[1]?.trim();
        expect(fg).toBeDefined();
        const tokens = themes[theme];
        const ratio = contrast(color(fg!, tokens), color("var(--ground)", tokens));
        expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(MIN_CONTRAST);
      });
    }
  }
});
