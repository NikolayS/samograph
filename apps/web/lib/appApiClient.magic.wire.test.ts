/**
 * OVER-THE-WIRE contract test for the REAL `createHttpAppApiClient` magic-link
 * methods. The existing `appApiClient.wire.test.ts` covers only create/list; the
 * auth wire (requestMagicLink / verifyMagicLink / lastDevMagicLink) was untested,
 * so a body-key or endpoint drift here would ship silently (sign-in is the front
 * door). Stands up a real `Bun.serve` on an ephemeral port, records the exact
 * request each method sends, and asserts the typed `AppApiError` mapping.
 *
 * Pure Bun (no DOM).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHttpAppApiClient, AppApiError } from "./appApiClient.ts";

/** Captured requests, keyed by "METHOD path". */
let last: { method: string; path: string; query: URLSearchParams; body: unknown; contentType: string | null } | null =
  null;
/** Per-route canned responses the current test wants the server to return. */
type Canned = { status: number; json?: unknown; text?: string };
const canned: Record<string, Canned> = {
  "POST /auth/magic-link": { status: 200, json: { ok: true } },
  "GET /auth/callback": { status: 200, json: { ok: true } },
  "GET /__dev/last-magic-link": { status: 200, json: { link: "unset" } },
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    let body: unknown = null;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = null;
      }
    }
    last = { method: req.method, path: url.pathname, query: url.searchParams, body, contentType: req.headers.get("content-type") };
    const c = canned[key];
    if (!c) return new Response("not found", { status: 404 });
    if (c.text !== undefined) return new Response(c.text, { status: c.status });
    return Response.json(c.json ?? {}, { status: c.status });
  },
});
const client = createHttpAppApiClient(`http://localhost:${server.port}`);

beforeAll(() => {
  last = null;
});
afterAll(() => {
  server.stop(true);
});

describe("appApiClient magic-link wire", () => {
  it("requestMagicLink POSTs /auth/magic-link with exactly {email} and resolves void on 200", async () => {
    canned["POST /auth/magic-link"] = { status: 200, json: { ok: true } };
    await expect(client.requestMagicLink({ email: "user@example.com" })).resolves.toBeUndefined();
    expect(last?.method).toBe("POST");
    expect(last?.path).toBe("/auth/magic-link");
    expect(last?.contentType).toContain("application/json");
    expect(last?.body).toEqual({ email: "user@example.com" });
  });

  it("requestMagicLink throws typed AppApiError from the body on failure", async () => {
    canned["POST /auth/magic-link"] = { status: 429, json: { code: "SAMO-RATE-001", message: "Too many.", retryable: true } };
    const err = await client.requestMagicLink({ email: "x@y.z" }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppApiError);
    expect(err.code).toBe("SAMO-RATE-001");
    expect(err.message).toBe("Too many.");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  it("requestMagicLink falls back to SAMO-AUTH-004 when the error body has no code", async () => {
    canned["POST /auth/magic-link"] = { status: 500, json: {} };
    const err = await client.requestMagicLink({ email: "x@y.z" }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppApiError);
    expect(err.code).toBe("SAMO-AUTH-004");
    expect(err.message).toBe("Request failed.");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(500);
  });

  it("verifyMagicLink GETs /auth/callback with the URL-encoded token and resolves void on 200", async () => {
    canned["GET /auth/callback"] = { status: 200, json: { ok: true } };
    await expect(client.verifyMagicLink("tok en/+42")).resolves.toBeUndefined();
    expect(last?.method).toBe("GET");
    expect(last?.path).toBe("/auth/callback");
    expect(last?.query.get("token")).toBe("tok en/+42"); // decoded round-trip proves it was encodeURIComponent'd
  });

  it("verifyMagicLink throws the exact typed error on 401", async () => {
    canned["GET /auth/callback"] = {
      status: 401,
      json: { code: "SAMO-AUTH-001", message: "This sign-in link isn't valid.", retryable: false },
    };
    const err = await client.verifyMagicLink("bad").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppApiError);
    expect(err.code).toBe("SAMO-AUTH-001");
    expect(err.message).toBe("This sign-in link isn't valid.");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(401);
  });

  it("verifyMagicLink falls back to SAMO-AUTH-001 on a non-JSON error body", async () => {
    canned["GET /auth/callback"] = { status: 500, text: "<html>boom</html>" };
    const err = await client.verifyMagicLink("t").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppApiError);
    expect(err.code).toBe("SAMO-AUTH-001");
    expect(err.message).toBe("Request failed.");
    expect(err.status).toBe(500);
  });

  it("lastDevMagicLink GETs /__dev/last-magic-link?email= and returns the link on 200", async () => {
    canned["GET /__dev/last-magic-link"] = { status: 200, json: { link: "http://localhost:3000/auth/callback?token=abc" } };
    const link = await client.lastDevMagicLink("dev@local.test");
    expect(last?.method).toBe("GET");
    expect(last?.path).toBe("/__dev/last-magic-link");
    expect(last?.query.get("email")).toBe("dev@local.test");
    expect(link).toBe("http://localhost:3000/auth/callback?token=abc");
  });

  it("lastDevMagicLink returns null on 404 and on a body missing link", async () => {
    canned["GET /__dev/last-magic-link"] = { status: 404, json: { error: "none yet" } };
    expect(await client.lastDevMagicLink("dev@local.test")).toBeNull();
    canned["GET /__dev/last-magic-link"] = { status: 200, json: { to: "dev@local.test" } };
    expect(await client.lastDevMagicLink("dev@local.test")).toBeNull();
  });
});
