import { describe, it, expect } from "bun:test";
import { botName } from "../src/botName.ts";

describe("botName", () => {
  it("with agent name", () => {
    expect(botName("TARS")).toBe("TARS \u{1F534} (samocall)");
  });

  it("without agent name (null)", () => {
    expect(botName(null)).toBe("samocall \u{1F534}");
  });

  it("without agent name (empty string)", () => {
    // empty string is falsy — same as null
    expect(botName("")).toBe("samocall \u{1F534}");
  });

  it("truncated at 100 code points", () => {
    const result = botName("A".repeat(200));
    expect([...result].length).toBeLessThanOrEqual(100);
  });

  it("truncation preserves prefix", () => {
    const result = botName("X".repeat(200));
    expect(result.startsWith("X")).toBe(true);
    expect([...result].length).toBe(100);
  });

  it("exact boundary name not truncated", () => {
    const suffix = " \u{1F534} (samocall)"; // 15 code points
    const namePart = "B".repeat(100 - [...suffix].length);
    const result = botName(namePart);
    expect([...result].length).toBe(100);
  });
});
