/**
 * Dev-proxy rewrite contract for the SHARE routes (SPEC §4.1, §5.7, Story 2).
 *
 * The ShareModal's `createHttpShareApiClient` fetches SAME-ORIGIN
 * `/calls/:id/share` + `/calls/:id/share/rotate` with the session cookie. On the
 * public web origin those paths must be proxied to the app-api exactly like
 * `/calls/:id` — gated on `sec-fetch-dest: empty` so only the client's `fetch`
 * (never a document navigation) reaches the API. Without these rewrites the
 * owner can never MINT a link from the web origin (the Sprint-2 share bug #2).
 *
 * Strict red/green TDD: written BEFORE the rewrites exist in next.config.mjs.
 */
import { describe, it, expect, beforeAll } from "bun:test";

const ORIGIN = "http://app-api.test:8787";

interface Rewrite {
  source: string;
  destination: string;
  has?: Array<{ type: string; key: string; value?: string }>;
}

let beforeFiles: Rewrite[] = [];

beforeAll(async () => {
  process.env.APP_API_ORIGIN = ORIGIN;
  // Dynamic specifier on purpose: the untyped .mjs config is outside the root
  // tsc glob; a static import would fail the repo-wide typecheck.
  const mod = (await import("./next.config" + ".mjs")) as {
    default: { rewrites?: () => Promise<{ beforeFiles: Rewrite[] }> };
  };
  const rewrites = await mod.default.rewrites?.();
  beforeFiles = rewrites?.beforeFiles ?? [];
});

const SEC_FETCH_DEST_EMPTY = [{ type: "header", key: "sec-fetch-dest", value: "empty" }];

describe("next.config.mjs — share-route dev-proxy rewrites (§4.1/§5.7)", () => {
  it("proxies the client's /calls/:id/share fetch (dest empty) to the app-api", () => {
    expect(beforeFiles).toContainEqual({
      source: "/calls/:id/share",
      has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calls/:id/share`,
    });
  });

  it("proxies the client's /calls/:id/share/rotate fetch (dest empty) to the app-api", () => {
    expect(beforeFiles).toContainEqual({
      source: "/calls/:id/share/rotate",
      has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calls/:id/share/rotate`,
    });
  });

  it("keeps the existing /calls/:id header-gated rewrite intact", () => {
    expect(beforeFiles).toContainEqual({
      source: "/calls/:id",
      has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calls/:id`,
    });
  });
});
