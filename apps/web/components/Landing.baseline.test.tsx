import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Landing } from "./Landing.tsx";
import { installDom } from "../test/setup.tsx";

installDom();

const fixture = join(import.meta.dir, "__fixtures__", "landing.baseline.html");

describe("Landing DOM baseline", () => {
  it("renders the simplified landing markup exactly", () => {
    const { container } = render(<Landing />);
    if (process.env.LANDING_BASELINE_WRITE === "1") {
      writeFileSync(fixture, container.innerHTML);
    }
    expect(container.innerHTML).toBe(readFileSync(fixture, "utf8"));
  });
});
