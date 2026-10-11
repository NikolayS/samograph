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

/** The single rule for `source`, or `undefined` when none is registered. */
function ruleFor(source: string): Rewrite | undefined {
  const matches = beforeFiles.filter((r) => r.source === source);
  if (matches.length > 1) throw new Error(`duplicate rewrite for ${source}`);
  return matches[0];
}

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

/**
 * Google sign-in dev-proxy rewrites (issue #209, PR 6).
 *
 * The trap this locks: `/auth/callback` above is gated on `sec-fetch-dest: empty`
 * because it is BOTH a Next page and a client `fetch`. An OAuth round trip is the
 * opposite — `/auth/google/start` and `/auth/google/callback` are reached by a
 * top-level DOCUMENT navigation (dest `document`), so copying that `has` gate onto
 * them would make the browser miss the proxy and land on a Next 404 instead of the
 * API. These two rules must therefore carry NO `has` condition at all.
 *
 * `/auth/providers` is the opposite again: a client `fetch` with no page behind
 * it, so it follows the `/auth/logout` pattern and IS gated.
 */
describe("next.config.mjs — Google sign-in dev-proxy rewrites (#209)", () => {
  it("proxies /auth/google/start UNGATED (OAuth start is a document navigation)", () => {
    expect(beforeFiles).toContainEqual({
      source: "/auth/google/start",
      destination: `${ORIGIN}/auth/google/start`,
    });
  });

  it("registers NO `has` condition on /auth/google/start", () => {
    const rule = ruleFor("/auth/google/start");
    // `source` + `destination` and nothing else — asserted on the key set so this
    // cannot pass vacuously when the rule is missing altogether.
    expect(Object.keys(rule ?? {}).sort()).toEqual(["destination", "source"]);
    expect(rule?.has).toBeUndefined();
  });

  it("proxies /auth/google/callback UNGATED (Google redirects the document back)", () => {
    expect(beforeFiles).toContainEqual({
      source: "/auth/google/callback",
      destination: `${ORIGIN}/auth/google/callback`,
    });
  });

  it("registers NO `has` condition on /auth/google/callback", () => {
    const rule = ruleFor("/auth/google/callback");
    expect(Object.keys(rule ?? {}).sort()).toEqual(["destination", "source"]);
    expect(rule?.has).toBeUndefined();
  });

  it("proxies the client's /auth/providers fetch (dest empty) to the app-api", () => {
    expect(beforeFiles).toContainEqual({
      source: "/auth/providers",
      has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/auth/providers`,
    });
  });

  it("leaves the existing /auth/callback rule EXACTLY as it was (still gated)", () => {
    expect(ruleFor("/auth/callback")).toEqual({
      source: "/auth/callback",
      has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/auth/callback`,
    });
  });
});

describe("next.config.mjs — Calendar OAuth rewrites (#240)", () => {
  it("gates fetch routes and leaves the document callback ungated", () => {
    expect(ruleFor("/calendar/connect/start")).toEqual({
      source: "/calendar/connect/start", has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calendar/connect/start`,
    });
    expect(ruleFor("/calendar/status")).toEqual({
      source: "/calendar/status", has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calendar/status`,
    });
    expect(ruleFor("/calendar/meetings")).toEqual({
      source: "/calendar/meetings", has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calendar/meetings`,
    });
    expect(ruleFor("/calendar/meetings/:id")).toEqual({
      source: "/calendar/meetings/:id", has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calendar/meetings/:id`,
    });
    expect(ruleFor("/calendar/connection")).toEqual({
      source: "/calendar/connection", has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/calendar/connection`,
    });
    expect(ruleFor("/calendar/connect/callback")).toEqual({
      source: "/calendar/connect/callback",
      destination: `${ORIGIN}/calendar/connect/callback`,
    });
    expect(Object.keys(ruleFor("/calendar/connect/callback") ?? {}).sort()).toEqual([
      "destination", "source",
    ]);
  });
});

/**
 * Settings + account dev-proxy rewrites.
 *
 * `/settings` is BOTH a Next page and a client `fetch`, so it must be gated on
 * `sec-fetch-dest: empty`. There is no `/account` page, so that rewrite stays
 * ungated and handles the client's delete fetch directly.
 */
describe("next.config.mjs — settings + account dev-proxy rewrites", () => {
  it("proxies the client's /settings fetch (dest empty) to the app-api", () => {
    expect(ruleFor("/settings")).toEqual({
      source: "/settings",
      has: SEC_FETCH_DEST_EMPTY,
      destination: `${ORIGIN}/settings`,
    });
  });

  it("proxies /account UNGATED (there is no /account page)", () => {
    const rule = ruleFor("/account");
    expect(rule).toEqual({
      source: "/account",
      destination: `${ORIGIN}/account`,
    });
    expect(Object.keys(rule ?? {}).sort()).toEqual(["destination", "source"]);
  });
});
