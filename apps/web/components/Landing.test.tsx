import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { Landing } from "./Landing.tsx";
import { installDom } from "../test/setup.tsx";

installDom();

describe("Landing (marketing)", () => {
  it("renders the product name and a 'Get started' CTA into the auth flow", () => {
    const { getByRole } = render(<Landing />);
    expect(getByRole("heading", { level: 1 }).textContent).toBe("samograph");
    const cta = getByRole("link", { name: "Get started" }) as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe("/auth");
  });

  it("leads with the final v1 zero-setup tagline", () => {
    const { getByText } = render(<Landing />);
    expect(
      getByText("Zero-setup live transcripts for your Zoom and Google Meet calls."),
    ).toBeDefined();
  });

  it("honestly describes what v1 does — hosted, no CLI/token/tunnel", () => {
    const { getByText } = render(<Landing />);
    expect(
      getByText(
        "samograph is hosted — no local CLI, no Recall token, no tunnel to run. Sign in, add a meeting link, and watch the transcript stream live. Share it read-only with anyone, or download it when the call ends.",
      ),
    ).toBeDefined();
  });

  it("lists the four v1 steps in order (sign in → add → watch → share/download)", () => {
    const { getByRole } = render(<Landing />);
    const items = Array.from(getByRole("list").querySelectorAll("li")).map(
      (li) => li.textContent,
    );
    expect(items).toEqual([
      "Sign in with a magic link.",
      "Add a Zoom or Google Meet meeting link.",
      "Watch the transcript stream live.",
      "Share it read-only, or download it.",
    ]);
  });
});
