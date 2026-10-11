import { describe, expect, it } from "bun:test";
import { AppApiError, type Call } from "./appApiClient.ts";
import { createFakeAppApiClient } from "./fakeAppApiClient.ts";

describe("FakeAppApiClient.getCall", () => {
  const seeded: Call = {
    id: "call_1",
    meetingUrl: "https://zoom.us/j/1234567890?pwd=secret",
    provider: "zoom",
    status: "COULD_NOT_JOIN",
  };

  it("returns a seeded call by id and records GET /calls/:id", async () => {
    const client = createFakeAppApiClient({ seedCalls: [seeded] });
    expect(await client.getCall("call_1")).toEqual(seeded);
    expect(client.requests).toEqual([
      { path: "/calls/call_1", method: "GET", body: {} },
    ]);
  });

  it("rejects an unknown id with an AppApiError carrying status 404", async () => {
    const client = createFakeAppApiClient({ seedCalls: [seeded] });
    let thrown: unknown;
    try {
      await client.getCall("missing");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).status).toBe(404);
  });
});
