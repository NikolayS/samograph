import { describe, expect, it } from "bun:test";
import { DEFAULT_LOOPBACK_HOST, resolveLoopbackHostname } from "./listen.ts";

describe("hosted listener policy", () => {
  it("defaults every omitted or blank hostname to IPv4 loopback", () => {
    expect(resolveLoopbackHostname()).toBe(DEFAULT_LOOPBACK_HOST);
    expect(resolveLoopbackHostname("   ")).toBe(DEFAULT_LOOPBACK_HOST);
  });

  it("allows the canonical hosted IPv4 loopback", () => {
    expect(resolveLoopbackHostname("127.0.0.1")).toBe("127.0.0.1");
  });

  for (const host of ["0.0.0.0", "::", "::1", "192.0.2.10", "samograph.samo.team", "localhost"]) {
    it(`fails closed for non-canonical host ${host}`, () => {
      expect(() => resolveLoopbackHostname(host)).toThrow("non-loopback");
    });
  }
});
