import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { Landing } from "./Landing.tsx";
import { installDom } from "../test/setup.tsx";

installDom();

/** Visible text with a space at every element boundary, so adjacent inline
 *  elements never merge into a single "word". */
function visibleText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  return Array.from(node.childNodes, visibleText).join(" ");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

describe("Landing (simplified)", () => {
  it("renders a single h1 stating what samograph is", () => {
    const { container, getAllByRole } = render(<Landing />);
    const headings = getAllByRole("heading", { level: 1 });
    expect(headings.length).toBe(1);
    expect(headings[0]!.textContent).toBe("An agent that joins your call and transcribes it live.");
    expect(container.querySelectorAll("h2, h3").length).toBe(0);
  });

  it("renders exactly one primary CTA in the hero, pointing at the auth route", () => {
    const { container } = render(<Landing />);
    const hero = container.querySelector(".samograph-landing-hero")!;
    const primary = Array.from(hero.querySelectorAll("a.samograph-button"));
    expect(primary.length).toBe(1);
    expect(primary[0]!.getAttribute("href")).toBe("/auth");
    expect(primary[0]!.textContent).toBe("Get started");
    const secondary = hero.querySelector("a.samograph-hero-secondary")!;
    expect(secondary.getAttribute("href")).toBe("https://github.com/NikolayS/samograph");
  });

  it("keeps nav to brand, theme switcher, and one sign-in link", () => {
    const { getByRole } = render(<Landing />);
    const nav = getByRole("navigation", { name: "Primary" });
    expect(nav.querySelector('img[src="/robot-mark.png"]')).not.toBeNull();
    expect(Array.from(nav.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual(["/", "/auth"]);
    expect(getByRole("group", { name: "Theme" })).toBeDefined();
  });

  it("drops the how-it-works steps, the fake instrument, features, heritage, and pricing", () => {
    const { container } = render(<Landing />);
    const text = container.textContent ?? "";
    for (const gone of [
      "Sign in",
      "How it works",
      "From link to live page",
      "four steps",
      "The bot joins",
      "heritage",
      "keyterms matched",
      "delivery degraded",
      "differentiators",
      "$0",
    ]) {
      expect(text).not.toContain(gone);
    }
    for (const gone of [
      ".samograph-steps",
      ".samograph-instrument",
      ".samograph-differentiators",
      ".samograph-heritage",
      ".samograph-closing",
      ".samograph-eyebrow",
      ".samograph-nav-links",
      ".samograph-pricing-grid",
    ]) {
      expect(container.querySelector(gone)).toBeNull();
    }
  });

  it("carries no sample transcript: no fake speakers, timestamps, or list", () => {
    const { container, queryByRole } = render(<Landing />);
    const text = container.textContent ?? "";
    for (const gone of ["Dana", "Morgan", "Jamie", "00:12"]) {
      expect(text).not.toContain(gone);
    }
    expect(queryByRole("list", { name: "Transcript format" })).toBeNull();
    expect(container.querySelector(".samograph-glimpse")).toBeNull();
    const hero = container.querySelector(".samograph-landing-hero")!;
    expect(hero.querySelectorAll("ol, ul, time").length).toBe(0);
  });

  it("keeps everything above the footer under 30 visible words", () => {
    const { container } = render(<Landing />);
    const main = container.querySelector("main.samograph-landing")!;
    expect(main.querySelector("footer")).toBeNull();
    const words = wordCount(visibleText(main));
    expect(words).toBe(26);
    expect(words).toBeLessThanOrEqual(30);
  });

  it("keeps the skip link first and focusable before the nav", () => {
    const { container, getByRole } = render(<Landing />);
    const skip = getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(container.querySelectorAll("a[href], button:not([disabled])")[0]).toBe(skip);
    expect(container.querySelector("main.samograph-landing")!.getAttribute("id")).toBe("main");
    // The footer sits outside <main> so it keeps its contentinfo landmark role.
    expect(container.querySelector("main footer")).toBeNull();
  });

  it("renders a minimal footer", () => {
    const { getByRole } = render(<Landing />);
    const labels = Array.from(getByRole("contentinfo").querySelectorAll("a"), (link) => link.textContent);
    expect(labels).toEqual(["get started", "cli on github", "hello@samograph.dev"]);
  });
});
