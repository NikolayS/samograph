import { describe, it, expect } from "bun:test";
import { PACKAGE_NAME } from "./index.ts";

describe("@samograph/shared", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@samograph/shared");
  });
});
