import { describe, expect, it } from "bun:test";
import { classifyNpmRelease } from "../scripts/npm-release";

describe("npm release channel guard", () => {
  const rc = "0.9.0-rc.1";
  it("keeps a GitHub prerelease off latest", () => {
    expect(classifyNpmRelease(rc, "release", `v${rc}`, "true", "")).toEqual({ publish: true, distTag: "rc" });
  });
  it("keeps a manually dispatched RC off latest", () => {
    expect(classifyNpmRelease(rc, "workflow_dispatch", `v${rc}`, "", "rc")).toEqual({ publish: true, distTag: "rc" });
    expect(() => classifyNpmRelease(rc, "workflow_dispatch", `v${rc}`, "", "latest")).toThrow();
    expect(() => classifyNpmRelease(rc, "workflow_dispatch", `v${rc}`, "", "")).toThrow();
  });
  it("allows an intentional stable release", () => {
    expect(classifyNpmRelease("0.9.0", "release", "v0.9.0", "false", "")).toEqual({ publish: true, distTag: "latest" });
    expect(classifyNpmRelease("0.9.0", "workflow_dispatch", "v0.9.0", "", "latest")).toEqual({ publish: true, distTag: "latest" });
  });
  it("rejects mismatched GitHub prerelease metadata", () => {
    expect(() => classifyNpmRelease(rc, "release", `v${rc}`, "false", "")).toThrow();
    expect(() => classifyNpmRelease("0.9.0", "release", "v0.9.0", "true", "")).toThrow();
    expect(() => classifyNpmRelease(rc, "release", `v${rc}`, "", "")).toThrow();
  });
  it("rejects missing/mismatched tags and unsupported versions", () => {
    for (const tag of ["", "v0.9.0", rc, "v0.9.0-rc.2"]) {
      expect(() => classifyNpmRelease(rc, "release", tag, "true", "")).toThrow();
    }
    for (const version of ["0.9.0-beta.1", "0.9.0-rc.0", "00.9.0", "0.9.0+build"]) {
      expect(() => classifyNpmRelease(version, "release", `v${version}`, "true", "")).toThrow();
    }
    expect(() => classifyNpmRelease("0.9.0", "push", "v0.9.0", "false", "")).toThrow();
    expect(() => classifyNpmRelease("0.9.0", "workflow_dispatch", "v0.9.0", "", "rc")).toThrow();
  });
  it("never publishes production deployment tags", () => {
    expect(classifyNpmRelease(rc, "release", "v20261011.1", "false", "")).toEqual({ publish: false });
  });
});
