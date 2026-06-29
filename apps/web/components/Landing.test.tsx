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
});
