import { appendFileSync, readFileSync } from "node:fs";

// Deliberately only stable SemVer and our rc.N release stage are publishable.
export function classifyNpmRelease(
  version: string, event: string, tag: string, prerelease: string, channel: string,
): { publish: boolean; distTag?: "rc" | "latest" } {
  if (event !== "release" && event !== "workflow_dispatch") throw new Error("Unsupported release event");
  // Production deploy tags are not npm releases.
  if (/^v[0-9]{8}\.[1-9][0-9]*$/.test(tag)) return { publish: false };
  const part = "(?:0|[1-9][0-9]*)";
  const match = new RegExp(`^${part}\\.${part}\\.${part}(-rc\\.[1-9][0-9]*)?$`).exec(version);
  if (!match) throw new Error("Only stable or rc.N package versions may be published");
  if (tag !== `v${version}`) throw new Error("Release tag must exactly match package.json version");
  const isRc = Boolean(match[1]);
  const distTag = isRc ? "rc" : "latest";
  if (event === "release") {
    if (prerelease !== String(isRc)) throw new Error("GitHub prerelease metadata must match package version");
  } else if (channel !== distTag) {
    throw new Error("Manual dispatch requires the matching explicit rc/latest channel");
  }
  return { publish: true, distTag };
}

if (import.meta.main) {
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const result = classifyNpmRelease(version, process.env.GITHUB_EVENT_NAME ?? "",
    process.env.RELEASE_TAG ?? "", process.env.RELEASE_PRERELEASE ?? "", process.env.RELEASE_CHANNEL ?? "");
  const output = `publish=${result.publish}\ndist_tag=${result.distTag ?? ""}\n`;
  console.log(output.trim());
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
