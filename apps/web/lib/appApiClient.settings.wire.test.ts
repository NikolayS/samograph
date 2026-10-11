/**
 * OVER-THE-WIRE contract test for `createHttpAppApiClient().getSettings()`'s
 * `signin` block (S5-1 item 8, issue #223).
 *
 * The component tests drive the in-memory fake, which hands back an already-
 * camelCased object and so cannot catch a wire-key mismatch — exactly the class
 * of bug `appApiClient.wire.test.ts` was written for (`meetingUrl` vs
 * `meeting_url`). The server serializes `connected_at`; the web domain reads
 * `connectedAt`. This drives the REAL fetch client at a real server emitting the
 * REAL body shape.
 *
 * Pure Bun (no DOM) — root `tsc --noEmit` typechecks this file with Bun types.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { createHttpAppApiClient } from "./appApiClient.ts";
import { AppApiError, isSessionInvalid } from "./apiError.ts";

/** What the next `GET /settings` answers with (set per test). */
let body: Record<string, unknown> = {};
/** When set, the next `GET /settings` answers with this BODYLESS status instead. */
let bodylessStatus: number | null = null;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/settings") {
      if (bodylessStatus !== null) return new Response(null, { status: bodylessStatus });
      return Response.json(body);
    }
    return new Response("not found", { status: 404 });
  },
});

const client = createHttpAppApiClient(`http://localhost:${server.port}`);

const SETTINGS_WIRE = {
  dictionary_preset: "none",
  keyterms: [],
  language: "multi",
  chime: "blip",
};
const OPTIONS_WIRE = { chimes: ["blip"], languages: [{ code: "multi", label: "Multi" }], presets: ["none"] };

afterAll(() => {
  server.stop(true);
});

describe("getSettings — the signin block over the wire (#223)", () => {
  it("maps snake_case connected_at → connectedAt and keeps the account email", async () => {
    body = {
      settings: SETTINGS_WIRE,
      options: OPTIONS_WIRE,
      signin: {
        email: "owner@example.test",
        identities: [{ provider: "google", connected_at: "2026-03-04T09:15:00.000Z" }],
      },
    };
    const snap = await client.getSettings();
    expect(snap.signin).toEqual({
      email: "owner@example.test",
      identities: [{ provider: "google", connectedAt: "2026-03-04T09:15:00.000Z" }],
    });
  });

  it("a magic-link-only account maps to an explicitly EMPTY identity list", async () => {
    body = {
      settings: SETTINGS_WIRE,
      options: OPTIONS_WIRE,
      signin: { email: "owner@example.test", identities: [] },
    };
    const snap = await client.getSettings();
    expect(snap.signin.identities).toEqual([]);
  });

  it("a missing/garbage signin block degrades to an empty shape, never undefined", async () => {
    body = { settings: SETTINGS_WIRE, options: OPTIONS_WIRE };
    expect((await client.getSettings()).signin).toEqual({ email: "", identities: [] });

    body = { settings: SETTINGS_WIRE, options: OPTIONS_WIRE, signin: { identities: "nope" } };
    expect((await client.getSettings()).signin).toEqual({ email: "", identities: [] });
  });

  it("drops an identity entry that carries no usable provider string", async () => {
    body = {
      settings: SETTINGS_WIRE,
      options: OPTIONS_WIRE,
      signin: {
        email: "owner@example.test",
        identities: [{ connected_at: "2026-03-04T09:15:00.000Z" }, { provider: "google" }],
      },
    };
    const snap = await client.getSettings();
    expect(snap.signin.identities).toEqual([{ provider: "google", connectedAt: null }]);
  });
});

/**
 * app-api answers an expired/missing session with a BODYLESS 401 (#114, #300) —
 * no JSON at all. The decoder must not choke on the empty body: it must still
 * produce an AppApiError carrying `status: 401` so the UI routes to /auth
 * (the shape that motivated the apiError.ts fix in #297).
 */
describe("getSettings — a bodyless 401 over the wire (#300)", () => {
  it("throws AppApiError with status 401 (not a JSON-parse TypeError)", async () => {
    bodylessStatus = 401;
    try {
      await client.getSettings();
      throw new Error("expected getSettings() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AppApiError);
      const e = err as AppApiError;
      expect(e.status).toBe(401);
      expect(e.message).toBe("Request failed.");
      expect(isSessionInvalid(e)).toBe(true); // → the UI redirects to /auth
    } finally {
      bodylessStatus = null;
    }
  });
});
