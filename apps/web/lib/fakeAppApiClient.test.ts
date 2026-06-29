import { describe, it, expect } from "bun:test";
import { createFakeAppApiClient } from "./fakeAppApiClient.ts";
import { AppApiError } from "./appApiClient.ts";

describe("FakeAppApiClient — records request shape, no network", () => {
  it("requestMagicLink records an exact POST /auth/magic-link {email}", async () => {
    const client = createFakeAppApiClient();
    await client.requestMagicLink({ email: "dev@samograph.dev" });
    expect(client.requests).toEqual([
      { path: "/auth/magic-link", method: "POST", body: { email: "dev@samograph.dev" } },
    ]);
  });

  it("verifyMagicLink records an exact GET /auth/callback and resolves by default", async () => {
    const client = createFakeAppApiClient();
    await client.verifyMagicLink("tok-123");
    expect(client.requests).toEqual([
      { path: "/auth/callback", method: "GET", body: { token: "tok-123" } },
    ]);
  });

  it("verifyMagicLink rejects with the configured typed AppApiError", async () => {
    const client = createFakeAppApiClient({
      failVerifyWith: {
        code: "SAMO-AUTH-003",
        message: "This link was already used.",
      },
    });
    let thrown: unknown;
    try {
      await client.verifyMagicLink("used-token");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-AUTH-003");
  });

  it("createCall records POST /calls and returns a PENDING call with derived provider", async () => {
    const client = createFakeAppApiClient();
    const call = await client.createCall({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(call).toEqual({
      id: "call_1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      provider: "google_meet",
      status: "PENDING",
    });
    expect(client.requests).toEqual([
      {
        path: "/calls",
        method: "POST",
        body: { meetingUrl: "https://meet.google.com/abc-defg-hij" },
      },
    ]);
  });

  it("createCall assigns monotonically increasing ids", async () => {
    const client = createFakeAppApiClient();
    const first = await client.createCall({ meetingUrl: "https://zoom.us/j/1" });
    const second = await client.createCall({ meetingUrl: "https://zoom.us/j/2" });
    expect(first.id).toBe("call_1");
    expect(second.id).toBe("call_2");
    expect(second.provider).toBe("zoom");
  });

  it("createCall throws a typed error for an invalid meeting URL", async () => {
    const client = createFakeAppApiClient();
    let thrown: unknown;
    try {
      await client.createCall({ meetingUrl: "https://example.com/x" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-CALL-JOIN");
  });
});
