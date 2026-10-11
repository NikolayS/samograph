import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { PageHeader } from "./PageHeader.tsx";
import { installDom } from "../test/setup.tsx";

installDom();

/**
 * Desktop PR 5 (`docs/design/PLAN.md`) — one page header for every page.
 * The contract these assert is the accessible one: EXACTLY one `<h1>`, holding
 * exactly the title text, with the eyebrow and description as siblings rather
 * than extra text inside the heading (the `/calls/[id]` bug was a raw meeting
 * URL living inside the H1).
 */
describe("PageHeader", () => {
  it("renders the title as the page's only h1, with exactly the title text", () => {
    const { container } = render(<PageHeader title="Your calls" />);
    const headings = container.querySelectorAll("h1");
    expect(headings.length).toBe(1);
    expect(headings[0]?.tagName).toBe("H1");
    expect(headings[0]?.textContent).toBe("Your calls");
    expect(container.querySelector("h2")).toBe(null);
  });

  it("is a <header> landmark carrying the shared class", () => {
    const { container } = render(<PageHeader title="Settings" />);
    const header = container.querySelector("header");
    expect(header?.className).toContain("samograph-page-header");
  });

  it("omits the eyebrow, description and actions slots when unused", () => {
    const { container } = render(<PageHeader title="Settings" />);
    expect(container.querySelector(".samograph-page-header-eyebrow")).toBe(null);
    expect(container.querySelector(".samograph-page-header-description")).toBe(null);
    expect(container.querySelector(".samograph-page-header-actions")).toBe(null);
    expect(container.querySelector(".samograph-page-header--has-actions")).toBe(null);
  });

  it("renders the eyebrow ABOVE the title and outside the heading", () => {
    const { container } = render(
      <PageHeader eyebrow={<a href="/dashboard">← Dashboard</a>} title="Call · Monday" />,
    );
    const eyebrow = container.querySelector(".samograph-page-header-eyebrow");
    expect(eyebrow?.textContent).toBe("← Dashboard");
    expect(container.querySelector("h1")?.textContent).toBe("Call · Monday");
    // Document order: the eyebrow is the text column's first child, the h1 its
    // second — the back link reads BEFORE the title, not after it.
    const column = container.querySelector(".samograph-page-header-text");
    const order = [...(column?.children ?? [])].map((el) => `${el.tagName}.${el.className}`);
    expect(order).toEqual([
      "DIV.samograph-page-header-eyebrow",
      "H1.samograph-page-header-title",
    ]);
  });

  it("renders the description under the title, outside the heading", () => {
    const { container } = render(
      <PageHeader title="Settings" description="How samograph transcribes your calls." />,
    );
    const description = container.querySelector(".samograph-page-header-description");
    expect(description?.textContent).toBe("How samograph transcribes your calls.");
    expect(container.querySelector("h1")?.textContent).toBe("Settings");
  });

  it("renders an actions slot and flags the header so the grid can go two-column", () => {
    const { container } = render(
      <PageHeader title="Your calls" actions={<button type="button">New call</button>} />,
    );
    const actions = container.querySelector(".samograph-page-header-actions");
    expect(actions?.querySelector("button")?.textContent).toBe("New call");
    expect(container.querySelector("header")?.className).toContain(
      "samograph-page-header--has-actions",
    );
  });

  it("gives the header an accessible name from its own title", () => {
    const { container } = render(<PageHeader title="Settings" />);
    const header = container.querySelector("header");
    const titleId = container.querySelector("h1")?.id;
    expect(titleId).toBeTruthy();
    expect(header?.getAttribute("aria-labelledby")).toBe(titleId as string);
  });

  it("honours an explicit titleId so a caller can point aria-labelledby at it", () => {
    const { container } = render(<PageHeader title="Settings" titleId="settings-title" />);
    expect(container.querySelector("h1")?.id).toBe("settings-title");
  });

  it("appends a caller className instead of replacing the shared one", () => {
    const { container } = render(
      <PageHeader title="Call" className="samograph-call-view-heading" />,
    );
    const header = container.querySelector("header");
    expect(header?.className).toContain("samograph-page-header");
    expect(header?.className).toContain("samograph-call-view-heading");
  });
});
