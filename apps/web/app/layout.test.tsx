import { describe, it, expect, mock } from "bun:test";
import { Children, isValidElement, type ReactElement } from "react";

mock.module("next/font/local", () => ({
  default: () => ({ variable: "mock-jetbrains-mono" }),
}));

mock.module("next/font/google", () => ({
  Inter: () => ({ variable: "mock-inter-sans" }),
}));

const { default: RootLayout } = await import("./layout.tsx");

/**
 * Issue #70 — the owner saw a React "attributes of the server rendered HTML
 * didn't match the client properties" hydration warning at localhost:3000.
 *
 * Isolation proved this is a browser EXTENSION (Grammarly / ColorZilla) stamping
 * attributes onto <body> before hydration — NOT a SSR↔client divergence in our
 * code (the page is fully static and clean in a fresh headless browser).
 *
 * The standard, narrowly-scoped mitigation is `suppressHydrationWarning` on the
 * <body> element ONLY. React suppresses the warning just one level deep, so the
 * extension's body-attribute noise is silenced while any REAL mismatch inside
 * <main>/content still surfaces. This test locks that scope in.
 */
describe("RootLayout (app shell) — issue #70 hydration mitigation", () => {
  const tree = RootLayout({ children: null }) as ReactElement<{
    className?: string;
    suppressHydrationWarning?: boolean;
    children: ReactElement<{ suppressHydrationWarning?: boolean }>;
  }>;
  const children = Children.toArray(tree.props.children) as ReactElement<{
    suppressHydrationWarning?: boolean;
  }>[];
  const body = children.find((child) => child.type === "body")!;

  it("renders <html lang=\"en\"> wrapping a <body>", () => {
    expect(tree.type).toBe("html");
    expect(isValidElement(body)).toBe(true);
    expect(body.type).toBe("body");
  });

  it("suppresses hydration warnings on <body> (extension attribute injection)", () => {
    expect(body.props.suppressHydrationWarning).toBe(true);
  });

  it("suppresses on <html> because the no-flash theme script sets data-theme before hydration", () => {
    expect(tree.props.suppressHydrationWarning).toBe(true);
  });
});

/**
 * Prod rendering bug — the whole site fell back to the browser default serif.
 *
 * globals.css defines `--font-body`/`--font-display`/`--font-mono` on `:root`
 * as `var(--font-jetbrains), ...`. The next/font variable class (which defines
 * `--font-jetbrains`) was attached to <body> — a DESCENDANT of `:root` — so at
 * `:root` the var() substituted an undefined custom property. Per CSS spec that
 * makes the declaration invalid at computed-value time: the token computes to
 * `guaranteed-invalid`, `font-family: var(--font-body)` collapses, and the site
 * renders in Times New Roman. The variable class MUST live on <html>.
 */
describe("RootLayout — next/font variable class placement", () => {
  const tree = RootLayout({ children: null }) as ReactElement<{
    className?: string;
    children: ReactElement<{ className?: string }>;
  }>;
  const children = Children.toArray(tree.props.children) as ReactElement<{
    className?: string;
  }>[];
  const body = children.find((child) => child.type === "body")!;

  it("attaches the font variable class to <html> so :root font tokens resolve", () => {
    expect(tree.props.className ?? "").toContain("mock-jetbrains-mono");
    expect(tree.props.className ?? "").toContain("mock-inter-sans");
  });

  it("does not rely on <body> for the variable class", () => {
    expect(body.props.className ?? "").not.toContain("mock-jetbrains-mono");
  });
});
