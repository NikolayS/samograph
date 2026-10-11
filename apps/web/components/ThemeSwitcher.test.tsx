import { beforeEach, describe, expect, it } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { installDom } from "../test/setup.tsx";
import { ThemeSwitcher } from "./ThemeSwitcher.tsx";

installDom();

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
  });

  it("renders light, dark, and sys options", () => {
    const view = render(<ThemeSwitcher />);
    for (const name of ["light", "dark", "sys"]) {
      expect(view.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("applies and persists explicit themes", () => {
    const view = render(<ThemeSwitcher />);
    fireEvent.click(view.getByRole("button", { name: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("samograph-theme")).toBe("dark");
  });

  it("sys clears the override and persists system mode", () => {
    localStorage.setItem("samograph-theme", "dark");
    document.documentElement.dataset.theme = "dark";
    const view = render(<ThemeSwitcher />);
    fireEvent.click(view.getByRole("button", { name: "sys" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("samograph-theme")).toBe("sys");
  });

  it("still applies every theme when Web Storage is unavailable", () => {
    const originalStorage = globalThis.localStorage;
    const throwingStorage = {
      getItem() { throw new Error("storage unavailable"); },
      setItem() { throw new Error("storage unavailable"); },
      clear() { throw new Error("storage unavailable"); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: throwingStorage });

    try {
      let view: ReturnType<typeof render> | undefined;
      expect(() => { view = render(<ThemeSwitcher />); }).not.toThrow();
      expect(() => fireEvent.click(view!.getByRole("button", { name: "light" }))).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(() => fireEvent.click(view!.getByRole("button", { name: "dark" }))).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(() => fireEvent.click(view!.getByRole("button", { name: "sys" }))).not.toThrow();
      expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
    }
  });
});
