import { describe, it, expect } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import RootLayout from "./layout.tsx";

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
    suppressHydrationWarning?: boolean;
    children: ReactElement<{ suppressHydrationWarning?: boolean }>;
  }>;
  const body = tree.props.children;

  it("renders <html lang=\"en\"> wrapping a <body>", () => {
    expect(tree.type).toBe("html");
    expect(isValidElement(body)).toBe(true);
    expect(body.type).toBe("body");
  });

  it("suppresses hydration warnings on <body> (extension attribute injection)", () => {
    expect(body.props.suppressHydrationWarning).toBe(true);
  });

  it("does NOT suppress on <html>, so the mitigation stays narrow", () => {
    expect(tree.props.suppressHydrationWarning).toBeUndefined();
  });
});
