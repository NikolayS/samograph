import { afterAll, describe, expect, it } from "bun:test";
import { AppApiError, createHttpAgentApiClient, type AgentBinding } from "./agentApiClient.ts";
import { createFakeAgentApiClient } from "./fakeAgentApiClient.ts";

const metadata: AgentBinding = {
  id: "binding_1", call_id: "call/1", provider: "codex", native_session_id: "session-exact",
  label: "Review session", scopes: ["listen", "act:chat"],
  created_at: "2026-10-07T01:00:00.000Z", expires_at: "2026-10-07T02:00:00.000Z",
  last_request_at: null, revoked_at: null,
};
const received: Array<{ path: string; method: string; body: unknown; contentType: string | null }> = [];
const server = Bun.serve({ port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  received.push({ path, method: req.method, body: req.method === "POST" ? await req.json() : null,
    contentType: req.headers.get("content-type") });
  if (path.includes("denied")) return Response.json({ code: "SAMO-AUTHZ-001", message: "Not allowed." }, { status: 403 });
  if (req.method === "POST") return Response.json({ ...metadata, credential: "secret-once" }, { status: 201 });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  return Response.json({ bindings: [metadata] });
} });
afterAll(() => server.stop(true));

describe("hosted agent owner API", () => {
  it("uses exact JSON mint input, encoded call/binding paths, and metadata-only list", async () => {
    const client = createHttpAgentApiClient(`http://127.0.0.1:${server.port}`);
    const grant = { provider: "codex" as const, native_session_id: "session-exact", label: "Review session" };
    expect(await client.mintBinding("call/1", grant)).toEqual({ ...metadata, credential: "secret-once" });
    expect(await client.listBindings("call/1")).toEqual([metadata]);
    await client.revokeBinding("call/1", "binding/1");
    expect(received.slice(-3)).toEqual([
      { path: "/calls/call%2F1/agent-bindings", method: "POST", body: grant, contentType: "application/json" },
      { path: "/calls/call%2F1/agent-bindings", method: "GET", body: null, contentType: null },
      { path: "/calls/call%2F1/agent-bindings/binding%2F1", method: "DELETE", body: null, contentType: null },
    ]);
  });
  it("surfaces typed authorization errors", async () => {
    const client = createHttpAgentApiClient(`http://127.0.0.1:${server.port}`);
    const error = await client.listBindings("denied").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppApiError);
    expect((error as AppApiError).status).toBe(403);
  });
  it("fake never persists the minted secret in metadata, conflicts until revoke, and isolates calls", async () => {
    const client = createFakeAgentApiClient();
    const grant = { provider: "codex" as const, native_session_id: "exact", label: "Review" };
    const minted = await client.mintBinding("call_1", grant);
    expect(minted.credential).toBe("fixture-credential-1");
    expect(JSON.stringify(await client.listBindings("call_1"))).not.toContain("credential");
    expect(await client.listBindings("call_2")).toEqual([]);
    expect(await client.mintBinding("call_1", grant).catch((e: AppApiError) => e.status)).toBe(409);
    await client.revokeBinding("call_1", minted.id);
    expect((await client.listBindings("call_1"))[0]?.revoked_at).not.toBeNull();
    expect((await client.mintBinding("call_1", grant)).id).toBe("binding_2");
  });
});
