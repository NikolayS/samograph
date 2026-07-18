import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { Landing } from "./Landing.tsx";
import { installDom } from "../test/setup.tsx";

installDom();

describe("Landing (Greenroom hero)", () => {
  it("leads with a display headline and a 'Get started' CTA into the auth flow", () => {
    const { getByRole } = render(<Landing />);
    const h1 = getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe(
      "Zero-setup live transcripts for your Zoom and Google Meet calls.",
    );
    // The CTA is an accessible link/button named "Get started" into /auth.
    const cta = getByRole("link", { name: /get started/i }) as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe("/auth");
  });

  it("keeps the truthful hosted value prop — no CLI, no Recall token, no tunnel", () => {
    const { getByText } = render(<Landing />);
    expect(
      getByText(
        "samograph is hosted — no local CLI, no Recall token, no tunnel to run. Sign in, add a meeting link, and watch the transcript stream live. Share it read-only with anyone, or download it when the call ends.",
      ),
    ).toBeDefined();
  });

  it("lists the four v1 steps in order (sign in → add → watch → share/download)", () => {
    const { getByRole } = render(<Landing />);
    const steps = getByRole("list", { name: "How it works" });
    const items = Array.from(steps.querySelectorAll("li")).map(
      (li) => li.textContent,
    );
    expect(items).toEqual([
      "Sign in with a magic link.",
      "Add a Zoom or Google Meet meeting link.",
      "Watch the transcript stream live.",
      "Share it read-only, or download it.",
    ]);
  });

  it("shows an illustrative product-preview panel clearly marked as a sample, not live data", () => {
    const { getByText, getByRole } = render(<Landing />);
    // The panel is explicitly labeled an example — never the viewer's real call.
    expect(
      getByText("Sample transcript — an illustrative example, not a live call."),
    ).toBeDefined();
    // A couple of `[HH:MM:SS] Speaker: …` sample lines are rendered.
    const sample = getByRole("list", { name: "Sample transcript lines" });
    const lines = Array.from(sample.querySelectorAll("li")).map(
      (li) => li.textContent,
    );
    expect(lines).toEqual([
      "[00:00:04] Alex: Morning — can everyone hear me okay?",
      "[00:00:11] Priya: Loud and clear. Let's start with the rollout.",
      "[00:00:18] Alex: So the cutover plan is",
    ]);
  });
});
