import { describe, it, expect } from "bun:test";
import {
  cloudflaredBinary,
  parseCloudflaredUrl,
  waitForCloudflaredUrl,
} from "../src/tunnel.ts";

// Real-world shape of the cloudflared quick-tunnel stderr banner.
const CLOUDFLARED_BANNER = `2026-06-11T17:00:01Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee.
2026-06-11T17:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-06-11T17:00:02Z INF +--------------------------------------------------------------------------------------------+
2026-06-11T17:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-06-11T17:00:02Z INF |  https://random-words-here-1234.trycloudflare.com                                          |
2026-06-11T17:00:02Z INF +--------------------------------------------------------------------------------------------+
2026-06-11T17:00:02Z INF Version 2026.5.0
`;

describe("parseCloudflaredUrl", () => {
  it("extracts the assigned trycloudflare URL from the banner", () => {
    expect(parseCloudflaredUrl(CLOUDFLARED_BANNER)).toBe(
      "https://random-words-here-1234.trycloudflare.com",
    );
  });

  it("returns null when no tunnel URL is present yet", () => {
    expect(parseCloudflaredUrl("")).toBeNull();
    expect(
      parseCloudflaredUrl("2026-06-11T17:00:01Z INF Requesting new quick Tunnel on trycloudflare.com..."),
    ).toBeNull();
  });

  it("does not match non-https or non-trycloudflare URLs", () => {
    expect(parseCloudflaredUrl("http://evil.trycloudflare.com.attacker.example")).toBeNull();
    expect(parseCloudflaredUrl("https://example.com")).toBeNull();
  });
});

describe("waitForCloudflaredUrl", () => {
  it("polls the reader until the URL appears in the output", async () => {
    const sleeps: number[] = [];
    let text = "starting up...\n";
    let reads = 0;
    const url = await waitForCloudflaredUrl(
      () => {
        reads += 1;
        if (reads === 3) text = CLOUDFLARED_BANNER;
        return text;
      },
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(url).toBe("https://random-words-here-1234.trycloudflare.com");
    expect(reads).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  it("times out and returns null when the URL never appears", async () => {
    let reads = 0;
    const url = await waitForCloudflaredUrl(
      () => {
        reads += 1;
        return "no url here";
      },
      async () => {},
      5,
    );
    expect(url).toBeNull();
    expect(reads).toBe(5);
  });

  it("aborts early when the process reports an error", async () => {
    let reads = 0;
    const url = await waitForCloudflaredUrl(
      () => {
        reads += 1;
        return "";
      },
      async () => {},
      40,
      () => reads >= 2, // e.g. spawn ENOENT
    );
    expect(url).toBeNull();
    expect(reads).toBeLessThan(5);
  });
});

describe("cloudflaredBinary", () => {
  it("prefers CLOUDFLARED_BIN when set", () => {
    expect(cloudflaredBinary({ CLOUDFLARED_BIN: "/opt/bin/cloudflared" })).toBe(
      "/opt/bin/cloudflared",
    );
  });

  it("falls back to cloudflared from PATH", () => {
    expect(cloudflaredBinary({})).toBe("cloudflared");
  });
});
