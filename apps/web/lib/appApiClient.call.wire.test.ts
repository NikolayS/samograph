/**
 * OVER-THE-WIRE contract tests for `createHttpAppApiClient().getCall(id)`.
 *
 * Component tests use the in-memory fake and therefore cannot catch a mismatch
 * between the API's snake_case `meeting_url` and the web domain's camelCase
 * `meetingUrl`. These tests drive the real fetch client against a real Bun
 * server so a query-bearing join URL is proved intact at the wire boundary.
 *
 * Pure Bun (no DOM) — root `tsc --noEmit` typechecks this file with Bun types.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { AppApiError, createHttpAppApiClient } from "./appApiClient.ts";

let status = 200;
let body: Record<string, unknown> = {};
let requestPath = "";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    requestPath = new URL(req.url).pathname;
    if (req.method === "GET" && requestPath.startsWith("/calls/")) {
      return Response.json(body, { status });
    }
    return new Response("not found", { status: 404 });
  },
});

const client = createHttpAppApiClient(`http://localhost:${server.port}`);

afterAll(() => {
  server.stop(true);
});

describe("getCall — one call over the wire (#286)", () => {
  it("maps the full raw Zoom URL and snake_case call fields", async () => {
    const id = "call/with spaces";
    status = 200;
    body = {
      id,
      meeting_url: "https://us04web.zoom.us/j/75208520803?pwd=s3cr3tPassw0rd",
      status: "COULD_NOT_JOIN",
      status_reason: "meeting_not_found",
      created_at: "2026-09-04T12:34:56.000Z",
    };

    expect(await client.getCall(id)).toEqual({
      id,
      meetingUrl: "https://us04web.zoom.us/j/75208520803?pwd=s3cr3tPassw0rd",
      provider: "zoom",
      status: "COULD_NOT_JOIN",
      statusReason: "meeting_not_found",
      createdAt: "2026-09-04T12:34:56.000Z",
    });
    expect(requestPath).toBe("/calls/call%2Fwith%20spaces");
  });

  it("maps a Google Meet URL to the google_meet provider", async () => {
    status = 200;
    body = {
      id: "call_google",
      meeting_url: "https://meet.google.com/abc-defg-hij",
      status: "PENDING",
    };
    expect((await client.getCall("call_google")).provider).toBe("google_meet");
  });

  it("rejects a 404 with an AppApiError carrying status 404", async () => {
    status = 404;
    body = { code: "SAMO-CALL-404", message: "Call not found." };
    let thrown: unknown;
    try {
      await client.getCall("missing");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).status).toBe(404);
  });

  it("maps a withheld meeting_url to an empty meetingUrl", async () => {
    status = 200;
    body = { id: "call_shared", status: "ENDED" };
    expect((await client.getCall("call_shared")).meetingUrl).toBe("");
  });
});
