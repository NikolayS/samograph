/**
 * OVER-THE-WIRE contract test for `createHttpAppApiClient().authProviders()`
 * (issue #209, PR 6 — `GET /auth/providers`).
 *
 * `/auth/providers` is the SOLE gate on rendering the "Continue with Google"
 * button, so its failure mode is a product decision, not a detail: a broken or
 * absent probe must never be able to break the sign-in page. The contract is
 * therefore "resolves to `{google:false}`, NEVER rejects" for every failure —
 * 5xx, network error, malformed JSON, missing field, non-boolean field. Each is
 * asserted individually rather than through one catch-all, because a client that
 * rejects on exactly one of them still bricks sign-in.
 *
 * Boolean-strict on the way in (`data.google === true`), mirroring the
 * `email_verified` rule on the server side of the same feature: the string
 * `"true"` and the number `1` are NOT `true`.
 *
 * Pure Bun (no DOM) — root `tsc --noEmit` typechecks this file with Bun types.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { createHttpAppApiClient } from "./appApiClient.ts";

/** What the stub server should answer on the next `GET /auth/providers`. */
type Mode =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "raw"; status: number; text: string; contentType: string };

let mode: Mode = { kind: "json", status: 200, body: { google: false } };

/** Every request the stub saw, so we assert the exact method + path on the wire. */
const seen: Array<{ method: string; path: string }> = [];

const server = Bun.serve({
  port: 0, // ephemeral port
  fetch(req) {
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname });
    if (url.pathname !== "/auth/providers") {
      return new Response("not found", { status: 404 });
    }
    if (mode.kind === "raw") {
      return new Response(mode.text, {
        status: mode.status,
        headers: { "content-type": mode.contentType },
      });
    }
    return Response.json(mode.body, { status: mode.status });
  },
});

const client = createHttpAppApiClient(`http://localhost:${server.port}`);

/**
 * A client pointed at a port with nothing listening: `fetch` REJECTS before any
 * HTTP status exists. Port 1 is privileged and never bound by this suite.
 */
const deadClient = createHttpAppApiClient("http://127.0.0.1:1");

afterAll(() => {
  server.stop(true);
});

describe("authProviders — GET /auth/providers over the wire (#209)", () => {
  it("GETs exactly /auth/providers and returns {google:true} on a true body", async () => {
    seen.length = 0;
    mode = { kind: "json", status: 200, body: { google: true } };
    expect(await client.authProviders()).toEqual({ google: true });
    expect(seen).toEqual([{ method: "GET", path: "/auth/providers" }]);
  });

  it("returns {google:false} on a false body", async () => {
    mode = { kind: "json", status: 200, body: { google: false } };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("maps google_calendar only when it is boolean true", async () => {
    mode = { kind: "json", status: 200, body: { google: false, google_calendar: true } };
    expect(await client.authProviders()).toEqual({ google: false, googleCalendar: true });
    mode = { kind: "json", status: 200, body: { google: false, google_calendar: "true" } };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("resolves {google:false} on HTTP 500 (never rejects)", async () => {
    mode = { kind: "json", status: 500, body: { error: "boom" } };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("resolves {google:false} on HTTP 404 (route not deployed yet)", async () => {
    mode = { kind: "json", status: 404, body: { google: true } };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("resolves {google:false} on a 200 with malformed JSON (never rejects)", async () => {
    mode = {
      kind: "raw",
      status: 200,
      text: "{not json at all",
      contentType: "application/json",
    };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("resolves {google:false} on a 200 HTML body (a proxy/error page)", async () => {
    mode = {
      kind: "raw",
      status: 200,
      text: "<!doctype html><title>nope</title>",
      contentType: "text/html",
    };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("resolves {google:false} when the `google` field is absent", async () => {
    mode = { kind: "json", status: 200, body: {} };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it('is boolean-strict: the STRING "true" is not true', async () => {
    mode = { kind: "json", status: 200, body: { google: "true" } };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("is boolean-strict: the NUMBER 1 is not true", async () => {
    mode = { kind: "json", status: 200, body: { google: 1 } };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("resolves {google:false} on a JSON null body", async () => {
    mode = { kind: "json", status: 200, body: null };
    expect(await client.authProviders()).toEqual({ google: false });
  });

  it("resolves {google:false} on a network error (never rejects)", async () => {
    expect(await deadClient.authProviders()).toEqual({ google: false });
  });
});
