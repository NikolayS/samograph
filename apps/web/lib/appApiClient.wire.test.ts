/**
 * OVER-THE-WIRE contract test for the REAL `createHttpAppApiClient`.
 *
 * The component tests run against the in-memory `FakeAppApiClient`, which records
 * a request *object* — it never serializes a JSON body to the server's contract.
 * That gap let a body-key mismatch ship: the web client POSTed `{ meetingUrl }`
 * (camelCase) while app-api reads `body.meeting_url` (snake_case, SPEC §5.2), so
 * every valid URL 400'd. This test closes that gap by standing up a real
 * `Bun.serve` whose handler is bound to app-api's ACTUAL `validateMeetingUrl` +
 * typed `SAMO-CALL-URL` error envelope, then driving the real fetch client at it.
 *
 * Pure Bun (no DOM) — root `tsc --noEmit` typechecks this file with Bun types.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHttpAppApiClient, AppApiError } from "./appApiClient.ts";
import { validateMeetingUrl } from "../../app-api/calls/validate.ts";
import { errorResponse, CALL_URL_INVALID } from "../../app-api/calls/errors.ts";

const MEET_URL = "https://meet.google.com/abc-defg-hij";
const ZOOM_URL = "https://us02web.zoom.us/j/89012345678";

/** The last JSON body app-api received on POST /calls (so we assert the wire key). */
let lastPostBody: Record<string, unknown> | null = null;
/** In-memory call rows, serialized exactly as the real `GET /calls` does (snake_case). */
const rows: Array<{ id: string; meeting_url: string; status: string }> = [];
let counter = 0;

const server = Bun.serve({
  port: 0, // ephemeral port
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/calls") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      lastPostBody = (body ?? {}) as Record<string, unknown>;
      // Read EXACTLY the key the real handler reads (apps/app-api/calls/http.ts).
      const candidate = (body as { meeting_url?: unknown } | null)?.meeting_url;
      const valid = validateMeetingUrl(candidate);
      if (!valid.ok) return errorResponse(CALL_URL_INVALID);
      counter += 1;
      const id = `call_${counter}`;
      rows.unshift({ id, meeting_url: valid.url, status: "PENDING" });
      return Response.json({ id, status: "PENDING" }, { status: 201 });
    }

    if (req.method === "GET" && url.pathname === "/calls") {
      return Response.json({ calls: rows }, { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
});

const baseUrl = `http://localhost:${server.port}`;
const client = createHttpAppApiClient(baseUrl);

beforeAll(() => {
  lastPostBody = null;
  rows.length = 0;
  counter = 0;
});
afterAll(() => {
  server.stop(true);
});

describe("createHttpAppApiClient — over-the-wire contract with app-api", () => {
  it("createCall serializes the server's `meeting_url` key (not camelCase)", async () => {
    const call = await client.createCall({ meetingUrl: MEET_URL });
    // The server received snake_case — this is the bug that 400'd every URL.
    expect(lastPostBody).toEqual({ meeting_url: MEET_URL });
    expect(call.status).toBe("PENDING");
    expect(call.id).toBe("call_1");
    expect(call.meetingUrl).toBe(MEET_URL);
    expect(call.provider).toBe("google_meet");
  });

  it("createCall maps a Zoom URL to a PENDING call with the zoom provider", async () => {
    const call = await client.createCall({ meetingUrl: ZOOM_URL });
    expect(call.status).toBe("PENDING");
    expect(call.provider).toBe("zoom");
    expect(call.meetingUrl).toBe(ZOOM_URL);
  });

  it("createCall surfaces the server's typed SAMO-CALL-URL on a bad URL", async () => {
    let thrown: unknown;
    try {
      // Passes the web client's loose check but FAILS app-api's strict code match.
      await client.createCall({ meetingUrl: "https://meet.google.com/not-a-code" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-CALL-URL");
    expect((thrown as AppApiError).message).toBe(
      "That doesn't look like a Zoom or Google Meet meeting link.",
    );
    expect((thrown as AppApiError).status).toBe(400);
  });

  it("listCalls reads `GET /calls` and maps snake_case rows to typed Calls", async () => {
    const calls = await client.listCalls();
    // The two created above (most-recent first), mapped to the web Call shape.
    expect(calls.map((c) => c.meetingUrl)).toEqual([ZOOM_URL, MEET_URL]);
    expect(calls.every((c) => c.status === "PENDING")).toBe(true);
    expect(calls.map((c) => c.provider)).toEqual(["zoom", "google_meet"]);
    expect(calls.map((c) => c.id)).toEqual(["call_2", "call_1"]);
  });
});
