import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { PageSkeleton } from "./PageSkeleton.tsx";
import { installDom } from "../test/setup.tsx";

installDom();

describe("PageSkeleton", () => {
  it("renders an accessible loading status and variant classes", () => {
    const { getByRole, rerender } = render(<PageSkeleton variant="form" />);
    const loading = getByRole("status", { name: "Loading" });
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.className).toBe("samograph-skeleton samograph-skeleton--form");
    expect(loading.textContent).toBe("Loading…");
    expect(loading.querySelector(".samograph-visually-hidden")?.textContent).toBe("Loading…");
    rerender(<PageSkeleton variant="page" />);
    expect(getByRole("status", { name: "Loading" }).className).toBe(
      "samograph-skeleton samograph-skeleton--page",
    );
  });

  it("replaces literal paragraph Suspense fallbacks on app pages", () => {
    const app = join(import.meta.dir, "../app");
    for (const file of ["auth/page.tsx", "auth/callback/page.tsx", "dashboard/page.tsx", "calls/[id]/page.tsx"]) {
      expect(readFileSync(join(app, file), "utf8")).not.toContain("<p>Loading…</p>");
    }
  });
});
