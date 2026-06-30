import { describe, it, expect } from "bun:test";
import { AppApiError } from "./appApiClient.ts";
import { createFakeShareApiClient } from "./fakeShareApiClient.ts";

describe("FakeShareApiClient — mint/rotate/revoke/get (SPEC §5.7, Story 2)", () => {
  it("mintShare records POST /calls/:id/share and returns a deterministic /c/<token> link", async () => {
    const client = createFakeShareApiClient();
    const link = await client.mintShare("call_1");
    expect(link).toEqual({ token: "shr_1", url: "/c/shr_1", active: true });
    expect(client.requests).toEqual([
      { path: "/calls/call_1/share", method: "POST" },
    ]);
  });

  it("getShare returns the active link minted for the call", async () => {
    const client = createFakeShareApiClient();
    await client.mintShare("call_1");
    const got = await client.getShare("call_1");
    expect(got).toEqual({ token: "shr_1", url: "/c/shr_1", active: true });
  });

  it("rotateShare issues a new, distinct token and the old one is no longer the active share", async () => {
    const client = createFakeShareApiClient();
    const first = await client.mintShare("call_1");
    const rotated = await client.rotateShare("call_1");
    expect(rotated.token).not.toBe(first.token);
    expect(rotated).toEqual({ token: "shr_2", url: "/c/shr_2", active: true });
    const got = await client.getShare("call_1");
    expect(got?.token).toBe("shr_2");
  });

  it("revokeShare makes getShare return null", async () => {
    const client = createFakeShareApiClient();
    await client.mintShare("call_1");
    await client.revokeShare("call_1");
    expect(await client.getShare("call_1")).toBeNull();
    expect(client.requests).toEqual([
      { path: "/calls/call_1/share", method: "POST" },
      { path: "/calls/call_1/share", method: "DELETE" },
      { path: "/calls/call_1/share", method: "GET" },
    ]);
  });

  it("getShare on a call with no share returns null without inventing a token", async () => {
    const client = createFakeShareApiClient();
    expect(await client.getShare("call_x")).toBeNull();
  });

  it("a configured SAMO-RATE-001 surfaces as a typed AppApiError with retryable honored", async () => {
    const client = createFakeShareApiClient({
      failMintWith: { code: "SAMO-RATE-001", message: "Too many connections/commands on this link.", retryable: true, status: 429 },
    });
    let thrown: unknown;
    try {
      await client.mintShare("call_1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-RATE-001");
    expect((thrown as AppApiError).retryable).toBe(true);
    // The failed request is still recorded (records, then throws).
    expect(client.requests).toEqual([{ path: "/calls/call_1/share", method: "POST" }]);
  });
});
