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
        body: { meeting_url: "https://meet.google.com/abc-defg-hij" },
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

  it("createCall throws app-api's typed SAMO-CALL-URL for an invalid meeting URL", async () => {
    const client = createFakeAppApiClient();
    let thrown: unknown;
    try {
      await client.createCall({ meetingUrl: "https://example.com/x" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-CALL-URL");
    expect((thrown as AppApiError).message).toBe(
      "That doesn't look like a Zoom or Google Meet meeting link.",
    );
  });

  it("listCalls returns created calls newest-first and survives a 'reload'", async () => {
    const client = createFakeAppApiClient();
    await client.createCall({ meetingUrl: "https://meet.google.com/abc-defg-hij" });
    await client.createCall({ meetingUrl: "https://zoom.us/j/123456789" });
    const listed = await client.listCalls();
    expect(listed.map((c) => c.id)).toEqual(["call_2", "call_1"]);
    // A fresh client seeded from the same rows (a "reload") still lists them.
    const reloaded = createFakeAppApiClient({ seedCalls: listed });
    expect((await reloaded.listCalls()).map((c) => c.id)).toEqual(["call_2", "call_1"]);
  });

  it("listCalls rejects with the configured typed error (auth-gate path)", async () => {
    const client = createFakeAppApiClient({
      failListCallsWith: { code: "SAMO-CALL-LIST", message: "no session", status: 401 },
    });
    let thrown: unknown;
    try {
      await client.listCalls();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).status).toBe(401);
  });

  it("logout records an exact POST /auth/logout and resolves by default", async () => {
    const client = createFakeAppApiClient();
    await client.logout();
    expect(client.requests).toEqual([
      { path: "/auth/logout", method: "POST", body: {} },
    ]);
  });

  it("logout rejects with the configured typed error (best-effort clients still redirect)", async () => {
    const client = createFakeAppApiClient({
      failLogoutWith: { code: "SAMO-AUTH-LOGOUT", message: "boom", status: 500 },
    });
    let thrown: unknown;
    try {
      await client.logout();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-AUTH-LOGOUT");
    // The request is still recorded before it rejects.
    expect(client.requests).toEqual([
      { path: "/auth/logout", method: "POST", body: {} },
    ]);
  });

  it("lastDevMagicLink returns the configured dev link or null", async () => {
    const withLink = createFakeAppApiClient({ devMagicLink: "http://x/auth/callback?token=t" });
    expect(await withLink.lastDevMagicLink("a@b.dev")).toBe("http://x/auth/callback?token=t");
    const without = createFakeAppApiClient();
    expect(await without.lastDevMagicLink("a@b.dev")).toBeNull();
  });
});
