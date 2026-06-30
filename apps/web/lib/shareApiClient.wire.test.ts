/**
 * OVER-THE-WIRE contract test for the REAL `createHttpShareApiClient`.
 *
 * The component/fake tests record request *objects* — they never serialize to
 * the server's contract. This test stands up a real `Bun.serve` implementing the
 * `/calls/:id/share` surface (mint / rotate / revoke / get, SPEC §4.1, §5.7) and
 * drives the real fetch client at it, asserting the exact method/path and the
 * serialized/deserialized key shapes, plus the typed `SAMO-RATE-001` envelope.
 *
 * Pure Bun (no DOM) — root `tsc --noEmit` typechecks this file with Bun types.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createHttpShareApiClient, AppApiError } from "./shareApiClient.ts";

/** Every request the server saw (method + path), for exact-shape assertions. */
let received: Array<{ method: string; path: string }> = [];
/** callId → current token (rotate supersedes; revoke deletes). */
const shares = new Map<string, string>();
let counter = 0;

function ratePath(id: string): boolean {
  return id === "call_rate";
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    received.push({ method: req.method, path: url.pathname });
    const m = url.pathname.match(/^\/calls\/([^/]+)\/share(\/rotate)?$/);
    if (!m) return new Response("not found", { status: 404 });
    const id = m[1]!;
    const isRotate = Boolean(m[2]);

    if (ratePath(id)) {
      return Response.json(
        { code: "SAMO-RATE-001", message: "Too many connections/commands on this link.", retryable: true },
        { status: 429 },
      );
    }

    if (req.method === "POST") {
      counter += 1;
      const token = `shr_${counter}`;
      shares.set(id, token);
      return Response.json({ token, url: `/c/${token}` }, { status: isRotate ? 200 : 201 });
    }
    if (req.method === "DELETE" && !isRotate) {
      shares.delete(id);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && !isRotate) {
      const token = shares.get(id);
      if (!token) return new Response(null, { status: 404 });
      return Response.json({ token, url: `/c/${token}`, active: true }, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
});

const baseUrl = `http://localhost:${server.port}`;
const client = createHttpShareApiClient(baseUrl);

beforeEach(() => {
  received = [];
  shares.clear();
  counter = 0;
});
afterAll(() => {
  server.stop(true);
});

describe("createHttpShareApiClient — over-the-wire contract", () => {
  it("mintShare POSTs /calls/:id/share and deserializes the token/url keys to a /c/<token> link", async () => {
    const link = await client.mintShare("call_1");
    expect(received).toEqual([{ method: "POST", path: "/calls/call_1/share" }]);
    expect(link).toEqual({ token: "shr_1", url: "/c/shr_1", active: true });
  });

  it("rotateShare POSTs /calls/:id/share/rotate and returns a new distinct token", async () => {
    const first = await client.mintShare("call_1");
    const rotated = await client.rotateShare("call_1");
    expect(received).toEqual([
      { method: "POST", path: "/calls/call_1/share" },
      { method: "POST", path: "/calls/call_1/share/rotate" },
    ]);
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.token).toBe("shr_2");
    const got = await client.getShare("call_1");
    expect(got?.token).toBe("shr_2");
  });

  it("revokeShare DELETEs the share; getShare then deserializes 404 → null", async () => {
    await client.mintShare("call_1");
    await client.revokeShare("call_1");
    expect(received.at(-1)).toEqual({ method: "DELETE", path: "/calls/call_1/share" });
    expect(await client.getShare("call_1")).toBeNull();
  });

  it("a 429 SAMO-RATE-001 envelope surfaces as a typed AppApiError with retryable honored", async () => {
    let thrown: unknown;
    try {
      await client.mintShare("call_rate");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-RATE-001");
    expect((thrown as AppApiError).retryable).toBe(true);
    expect((thrown as AppApiError).status).toBe(429);
  });
});
