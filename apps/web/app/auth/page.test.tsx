import { describe, expect, it, mock } from "bun:test";
import { render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { installDom } from "../../test/setup.tsx";

installDom();

mock.module("next/navigation", () => ({
  usePathname: () => "/auth",
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: AuthRequestPage } = await import("./page.tsx");
const { default: AuthCallbackPage } = await import("./callback/page.tsx");

describe("public auth route layout", () => {
  for (const [route, Page] of [["/auth", AuthRequestPage], ["/auth/callback", AuthCallbackPage]] as const) {
    it(`${route} renders the form-width public AppShell`, () => {
      const shell = Page() as ReactElement<{ children: unknown }>;
      const { getByRole } = render(createElement(shell.type, { ...shell.props, children: null }));
      expect(getByRole("main").className).toBe("samograph-page samograph-page--form");
      expect(getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
    });
  }
});
