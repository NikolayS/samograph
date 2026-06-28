import { describe, it, expect } from "bun:test";
import { SERVICE_NAME } from "./index.ts";

describe("@samograph/web", () => {
  it("service name is web", () => {
    expect(SERVICE_NAME).toBe("web");
  });
});
