import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Landing } from "../components/Landing.tsx";
import { installDom } from "./setup.tsx";

installDom();

const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const root = clean.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";

const expected: Record<string, string> = {
  "--font-sans": 'var(--font-inter, "Inter"), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--font-mono": 'var(--font-jetbrains, "JetBrains Mono"), ui-monospace, SFMono-Regular, Menlo, monospace',
  "--font-body": "var(--font-sans)", "--font-display": "var(--font-sans)",
  "--text-xs": "0.75rem", "--text-sm": "0.8125rem", "--text-base": "0.875rem", "--text-md": "1rem",
  "--text-lg": "1.25rem", "--text-xl": "1.75rem", "--text-2xl": "2.5rem",
  "--leading-tight": "1.2", "--leading-normal": "1.55", "--leading-prose": "1.7",
  "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px",
  "--space-5": "20px", "--space-6": "24px", "--space-8": "32px", "--space-10": "40px",
  "--space-12": "56px", "--space-16": "80px",
  "--radius-sm": "4px", "--radius-md": "6px", "--radius-lg": "8px", "--radius-pill": "999px",
  "--border": "1px", "--border-strong": "2px",
  "--width-app": "1120px", "--width-prose": "720px", "--width-form": "480px",
  "--gutter": "var(--space-8)", "--focus-ring": "var(--ink)",
  "--hover-surface": "color-mix(in srgb, var(--ink) 5%, var(--surface))",
  "--control-border": "var(--line-strong)",
};

function declaration(block: string, name: string): string | undefined {
  return block.match(new RegExp(`${name.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`))?.[1];
}

function rule(selector: RegExp): string | undefined {
  return clean.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, selector.flags.replace("g", "")))?.[1];
}

describe("Slice 1 design tokens", () => {
  for (const [name, value] of Object.entries(expected)) {
    it(`defines ${name} exactly`, () => expect(normalize(declaration(root, name) ?? "")).toBe(normalize(value)));
  }
});

describe("Slice 1 reset and shell CSS", () => {
  it("removes the legacy blanket 32rem main/section well", () =>
    expect(clean).not.toMatch(/main\s*,\s*section\s*\{[^}]*max-width\s*:\s*32rem/s));
  it("removes legacy body padding and the landing body workaround", () => {
    expect(rule(/body(?![:\w-])/)).not.toMatch(/padding\s*:\s*2rem/);
    expect(clean).not.toMatch(/body:has\(\.samograph-landing\)/);
  });
  it("removes margin-top from the bare button rule", () =>
    expect(rule(/button(?![:\w-])/)).not.toMatch(/margin-top\s*:/));
  it("uses border-box universally", () =>
    expect(normalize(rule(/\*\s*,\s*\*::before\s*,\s*\*::after/) ?? "")).toContain("box-sizing: border-box"));

  const dead = ["samograph-hero", "samograph-hero-cta", "samograph-hero-headline", "samograph-hero-steps", "samograph-hero-subhead", "samograph-hero-preview", "samograph-hero-transcript", "samograph-hero-line-partial", "samograph-hero-live-dot", "samograph-wordmark", "samograph-presence", "samograph-presence-pill"];
  for (const name of dead) {
    it(`removes dead .${name} selectors`, () => {
      const suffix = name === "samograph-hero" ? "(?=[\\s{,:>])" : "(?![\\w-])";
      expect(clean).not.toMatch(new RegExp(`\\.${name}${suffix}`));
    });
  }

  // PLAN.md PR 4 / DESIGN-MODEL §5: `<main>` keeps the shared page container
  // (`--page-max`, itself `--width-app`) so it aligns with the nav; the form
  // width moved off the page and onto the content column as `--content-max`.
  it("defines app and form page widths", () => {
    expect(rule(/\.samograph-page(?![-\w])/)).toMatch(/max-width\s*:\s*var\(--page-max\)/);
    expect(normalize(declaration(root, "--page-max") ?? "")).toBe("var(--width-app)");
    expect(rule(/\.samograph-page--form(?![-\w])/)).toMatch(/--content-max\s*:\s*var\(--width-form\)/);
  });
  it("reduces the gutter under 40rem", () =>
    expect(clean).toMatch(/@media\s*\(max-width:\s*40rem\)\s*\{[\s\S]*?:root\s*\{[^}]*--gutter\s*:\s*var\(--space-5\)/));
  it("gives select and textarea the shared focus ring", () => {
    const focusRule = [...clean.matchAll(/([^{}]+:focus-visible[^{}]*)\{([^}]*)\}/g)].find(([, selectors]) => selectors.includes("select:focus-visible") && selectors.includes("textarea:focus-visible"));
    expect(focusRule).toBeDefined();
    expect(focusRule?.[2]).toMatch(/var\(--focus-ring\)/);
  });
  it("defines a skip link", () => expect(clean).toMatch(/\.samograph-skip-link(?![\w-])\s*\{/));
});

describe("Slice 1 typography regressions", () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  });

  afterEach(() => style.remove());

  it("keeps the landing on the mono stack", () =>
    expect(rule(/\.samograph-landing(?![-\w])/)).toMatch(/font-family\s*:\s*var\(--font-mono\)/));

  it("overrides the global heading family after the global heading rule", () => {
    const landingHeadings = rule(/:where\(\.samograph-landing\) h1\s*,\s*:where\(\.samograph-landing\) h2\s*,\s*:where\(\.samograph-landing\) h3/);
    expect(landingHeadings).toMatch(/font-family\s*:\s*var\(--font-mono\)/);

    const globalHeadingIndex = clean.search(/h1\s*,\s*h2\s*,\s*h3\s*\{/);
    const landingHeadingIndex = clean.search(/:where\(\.samograph-landing\) h1\s*,\s*:where\(\.samograph-landing\) h2\s*,\s*:where\(\.samograph-landing\) h3\s*\{/);
    expect(globalHeadingIndex).toBeGreaterThanOrEqual(0);
    expect(landingHeadingIndex).toBeGreaterThan(globalHeadingIndex);
  });

  it("pins the landing heading weight and historical line heights", () => {
    const { container } = render(createElement(Landing));
    const heroHeading = container.querySelector<HTMLElement>(".samograph-landing-hero h1")!;
    expect(getComputedStyle(heroHeading).fontWeight).toBe("700");
    expect(getComputedStyle(heroHeading).lineHeight).toBe("1.14");
  });

  for (const selector of [/\.samograph-call-url/, /\.samograph-account-email/, /\.samograph-keyterms/]) {
    it(`keeps ${selector.source.slice(2)} on the mono stack`, () =>
      expect(rule(selector)).toMatch(/font-family\s*:\s*var\(--font-mono\)/));
  }
});

describe("Slice 4 responsive dashboard CSS", () => {
  it("stacks call and meeting rows into one column under 40rem", () => {
    const slice4 = css.match(/\/\* ===== Slice 4 — Dashboard ===== \*\/([\s\S]*?)\/\* ===== end Slice 4 ===== \*\//)?.[1] ?? "";
    const mobile = slice4.match(/@media\s*\(max-width:\s*40rem\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";
    expect(mobile).toMatch(/\.samograph-call-row\s*,\s*\.samograph-meeting-item\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)/s);
  });

  it("gives the status chip legible padding on both axes", () => {
    const slice4 = css.match(/\/\* ===== Slice 4 — Dashboard ===== \*\/([\s\S]*?)\/\* ===== end Slice 4 ===== \*\//)?.[1] ?? "";
    const chip = slice4.match(/\.samograph-status-chip\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(chip).toMatch(/padding\s*:\s*2px\s+var\(--space-2\)/);
    expect(chip).toMatch(/line-height\s*:\s*var\(--leading-tight\)/);
  });
});
