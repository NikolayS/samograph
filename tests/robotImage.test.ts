import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { presencePageHtml } from "../src/presence.ts";
import { ROBOT_DATA_URI } from "../src/robotImage.ts";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("robot avatar", () => {
  it("is a PNG data URL", () => {
    expect(ROBOT_DATA_URI.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("embeds the canonical avatar", () => {
    const embedded = Buffer.from(ROBOT_DATA_URI.split(",", 2)[1]!, "base64");
    const canonical = readFileSync(resolve(import.meta.dir, "../docs/avatar.png"));
    expect(sha256(embedded)).toBe(sha256(canonical));
  });

  it("renders the canonical robot image", () => {
    const html = presencePageHtml();
    expect(html).toContain(`id="robot" src="${ROBOT_DATA_URI}"`);
    expect(html).not.toMatch(/samoagent/i);
  });
});
