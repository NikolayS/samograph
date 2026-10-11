import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import {
  GoogleSignInButton,
  GOOGLE_SIGN_IN_LABEL,
  GOOGLE_SIGN_IN_HREF,
  GOOGLE_MARK_HEXES,
} from "./GoogleSignInButton.tsx";
import { installDom } from "../test/setup.tsx";

installDom();

/**
 * "Continue with Google" button (issue #209, PR 6).
 *
 * Google's *Sign in with Google* branding guidelines are a condition of using the
 * mark, so they are asserted here as a contract rather than left to review:
 *   - the label is one of Google's APPROVED strings — we ship `Continue with
 *     Google`, never invented copy;
 *   - the mark is the unmodified four-colour "G", so all four brand hexes must be
 *     present, unaltered;
 *   - NO extra content inside the button beyond the mark + the approved label.
 * The 40px minimum height, the 4px corner radius and the approved light/dark
 * colour sets are CSS; they are locked in `test/greenroom-tokens.test.ts` against
 * `globals.css`, which is why the class name is asserted here.
 *
 * It is a LINK, not a `fetch`: `/auth/google/start` 302s to Google, which only a
 * top-level document navigation can follow.
 */
describe("GoogleSignInButton — Google branding contract (#209)", () => {
  it("renders a LINK (document navigation), not a button", () => {
    const { getByRole, queryByRole } = render(<GoogleSignInButton />);
    expect(getByRole("link").tagName).toBe("A");
    expect(queryByRole("button")).toBeNull();
  });

  it("points at exactly /auth/google/start", () => {
    const { getByRole } = render(<GoogleSignInButton />);
    expect(getByRole("link").getAttribute("href")).toBe("/auth/google/start");
    expect(GOOGLE_SIGN_IN_HREF).toBe("/auth/google/start");
  });

  it("uses Google's approved label string, exactly", () => {
    const { getByRole } = render(<GoogleSignInButton />);
    expect(getByRole("link", { name: "Continue with Google" })).toBeDefined();
    expect(GOOGLE_SIGN_IN_LABEL).toBe("Continue with Google");
  });

  it("puts NO extra content in the button — the label is its whole text", () => {
    const { getByRole } = render(<GoogleSignInButton />);
    expect(getByRole("link").textContent).toBe("Continue with Google");
  });

  it("renders the unmodified four-colour Google mark", () => {
    const { getByRole } = render(<GoogleSignInButton />);
    const svg = getByRole("link").querySelector("svg");
    expect(svg).not.toBeNull();
    const fills = Array.from(svg?.querySelectorAll("path") ?? []).map((p) =>
      p.getAttribute("fill"),
    );
    // All four brand hexes, unaltered. Order is the mark's own path order.
    expect(fills).toEqual(["#4285F4", "#34A853", "#FBBC05", "#EA4335"]);
    expect(GOOGLE_MARK_HEXES).toEqual([
      "#4285F4",
      "#34A853",
      "#FBBC05",
      "#EA4335",
    ]);
  });

  it("hides the mark from assistive tech (the label already names the action)", () => {
    const { getByRole } = render(<GoogleSignInButton />);
    const svg = getByRole("link").querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
  });

  it("carries the branded class that supplies the 40px/4px/colour-set chrome", () => {
    const { getByRole } = render(<GoogleSignInButton />);
    expect(getByRole("link").getAttribute("class")).toBe("samograph-google-signin");
  });
});
