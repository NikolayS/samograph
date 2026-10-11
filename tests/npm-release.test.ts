import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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


describe("npm release workflow wiring", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8")) as any;
  it("grants publication identity only to the publish job", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.guard.permissions?.["id-token"]).not.toBe("write");
    expect(workflow.jobs.publish.permissions).toEqual({ contents: "read", "id-token": "write" });
  });
  it("pins publishing actions and Bun", () => {
    for (const job of Object.values(workflow.jobs) as any[]) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        if (step.uses?.startsWith("oven-sh/setup-bun@")) expect(step.with["bun-version"]).toBe("1.3.8");
      }
    }
  });
  it("publishes only a validated commit and skips deploy tags", () => {
    const { guard, build, publish } = workflow.jobs;
    expect(publish.needs).toEqual(["guard", "build"]);
    expect(build.needs).toBe("guard");
    expect(publish.if).toBe("needs.guard.outputs.publish == 'true'");
    expect(guard.outputs.publish).toBe("${{ steps.check.outputs.publish }}");
    expect(guard.outputs.sha).toBe("${{ steps.resolve.outputs.sha }}");
    expect(build.steps[0].with.ref).toBe("${{ needs.guard.outputs.sha }}");
    expect(guard.steps.find((s: any) => s.id === "check").if).toBe("steps.deploy.outputs.skip != 'true'");
  });
});


it("never builds or runs package scripts with publication privileges", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8")) as any;
  const { build, publish } = workflow.jobs;
  expect(build).toBeDefined();
  expect(build.permissions?.["id-token"]).not.toBe("write");
  expect(publish.steps.some((s: any) => s.uses?.startsWith("actions/checkout@"))).toBe(false);
  const commands = publish.steps.map((s: any) => s.run ?? "").join("\n");
  expect(commands).not.toMatch(/bun |npm (install|ci|run|pack)/);
  expect(commands).toContain("--ignore-scripts");
  expect(publish.needs).toEqual(["guard", "build"]);
});


it.each([
  ["release", "true", "", "v0.9.0-rc.1", 0, "publish=true\ndist_tag=rc\n"],
  ["workflow_dispatch", "null", "rc", "v0.9.0-rc.1", 0, "publish=true\ndist_tag=rc\n"],
  ["workflow_dispatch", "null", "latest", "v0.9.0-rc.1", 1, ""],
  ["release", "false", "", "v20261011.1", 0, "publish=false\ndist_tag=\n"],
])("release CLI maps %s metadata to outputs", (event, prerelease, channel, tag, code, output) => {
  const dir = mkdtempSync(join(tmpdir(), "npm-release-test-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.9.0-rc.1" }));
    const out = join(dir, "output");
    writeFileSync(out, "");
    const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("../scripts/npm-release.ts", import.meta.url))], {
      cwd: dir,
      env: { ...process.env, GITHUB_EVENT_NAME: String(event), RELEASE_PRERELEASE: String(prerelease), RELEASE_CHANNEL: String(channel), RELEASE_TAG: String(tag), GITHUB_OUTPUT: out },
    });
    expect(result.exitCode).toBe(Number(code));
    expect(readFileSync(out, "utf8")).toBe(String(output));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
