import { describe, it, expect } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { AgentConnectModal } from "./AgentConnectModal.tsx";
import { createFakeAgentApiClient } from "../lib/fakeAgentApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

function mount(client = createFakeAgentApiClient()) {
  return { client, ...render(<AgentConnectModal agentClient={client} callId="call_1" onClose={() => {}} />) };
}
async function grant(view: ReturnType<typeof mount>) {
  await view.findByRole("button", { name: "Grant access" });
  fireEvent.input(view.getByLabelText("Exact native session ID"), { target: { value: "session-123" } });
  fireEvent.input(view.getByLabelText("Label"), { target: { value: "My code review" } });
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Grant access" })));
}

describe("AgentConnectModal owner onboarding", () => {
  it("offers the setup guide before granting access", async () => {
    const view = mount();
    const link = view.getByRole("link", { name: "Set up your agent" });
    expect(link.getAttribute("href")).toBe("/agent-setup");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(view.queryByText("fixture-credential-1")).toBeNull();
  });
  it("discloses fixed scopes and expiry, requires exact session, then displays the secret only as text", async () => {
    const view = mount();
    expect(view.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    expect(view.getByText(/60 minutes/)).toBeDefined();
    expect(view.getByText(/listen.*act:chat/)).toBeDefined();
    expect((await view.findByRole("button", { name: "Grant access" }) as HTMLButtonElement).disabled).toBe(true);
    await grant(view);
    expect(await view.findByText("fixture-credential-1")).toBeDefined();
    expect(view.getByText("samograph agent --help")).toBeDefined();
    expect(view.client.requests.find((r) => r.method === "POST")?.body).toEqual({
      provider: "codex", native_session_id: "session-123", label: "My code review",
    });
    for (const element of view.container.querySelectorAll("*")) {
      for (const attribute of element.attributes) expect(attribute.value).not.toContain("fixture-credential-1");
    }
    expect(view.container.querySelector("input[value='fixture-credential-1']")).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(view.getByText(/last API request.*never/i)).toBeDefined();
    expect(view.getByText(/does not prove.*running/i)).toBeDefined();
    expect(view.getByText(/same local user/)).toBeDefined();
  });
  it("copies once, forgets on close/reopen, refreshes metadata, and revokes", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
    const view = mount();
    await grant(view);
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Copy credential" })));
    expect(writes).toEqual(["fixture-credential-1"]);
    view.unmount();
    const reopened = mount(view.client);
    await reopened.findByText("My code review");
    expect(reopened.queryByText("fixture-credential-1")).toBeNull();
    await act(async () => fireEvent.click(reopened.getByRole("button", { name: "Refresh status" })));
    await act(async () => fireEvent.click(reopened.getByRole("button", { name: "Revoke access" })));
    expect(await reopened.findByText("Revoked")).toBeDefined();
    expect(await reopened.findByRole("button", { name: "Grant access" })).toBeDefined();
  });
  it("a failed status load requires refresh before granting, and typed mint errors remain actionable", async () => {
    const view = mount(createFakeAgentApiClient({ failListWith: { code: "SAMO-AUTHZ-001", message: "Sign in again.", status: 403 } }));
    expect((await view.findByRole("alert")).textContent).toBe("Sign in again.");
    expect(view.queryByRole("button", { name: "Grant access" })).toBeNull();
    view.unmount();
    const failure = mount(createFakeAgentApiClient({ failMintWith: { code: "SAMO-AGENT-ACTIVE", message: "Revoke the existing session first.", status: 409 } }));
    await grant(failure);
    expect((await failure.findByRole("alert")).textContent).toBe("Revoke the existing session first.");
  });
  it("rejects non-ASCII, control characters and oversized native IDs before sending", async () => {
    const view = mount();
    await view.findByRole("button", { name: "Grant access" });
    for (const value of [" padded", "padded ", " padded ", "session-é", "session-東京", "session-🤖", "bad\u0001id", "bad\u007fid", "x".repeat(201)]) {
      fireEvent.input(view.getByLabelText("Exact native session ID"), { target: { value } });
      expect((view.getByRole("button", { name: "Grant access" }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(view.client.requests.filter((r) => r.method === "POST")).toEqual([]);
  });
  it("accepts an ASCII native session ID with a Unicode human label of at most 80 characters", async () => {
    const view = mount();
    await view.findByRole("button", { name: "Grant access" });
    fireEvent.input(view.getByLabelText("Exact native session ID"), { target: { value: "session-exact-123" } });
    fireEvent.input(view.getByLabelText("Label"), { target: { value: "東".repeat(81) } });
    expect((view.getByRole("button", { name: "Grant access" }) as HTMLButtonElement).disabled).toBe(true);
    const label = "東京 code review — café ".padEnd(80, "東");
    fireEvent.input(view.getByLabelText("Label"), { target: { value: label } });
    expect((view.getByRole("button", { name: "Grant access" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Grant access" })));
    expect(view.client.requests.find((r) => r.method === "POST")?.body).toEqual({
      provider: "codex", native_session_id: "session-exact-123", label,
    });
  });
  it("keeps expired unrevoked grants revocable and blocks a new grant until revoke", async () => {
    const view = mount(createFakeAgentApiClient({bindings:[{id:"expired-binding",call_id:"call_1",provider:"codex",native_session_id:"old-native",label:"Old session",scopes:["listen","act:chat"],created_at:"2020-01-01T00:00:00Z",expires_at:"2020-01-01T01:00:00Z",last_request_at:null,revoked_at:null}]}));
    expect(await view.findByText("Expired")).toBeDefined();
    expect(view.queryByRole("button", {name:"Grant access"}) === null).toBe(true);
    await act(async()=>fireEvent.click(view.getByRole("button", {name:"Revoke access"})));
    expect(await view.findByText("Revoked")).toBeDefined();
    expect(await view.findByRole("button", {name:"Grant access"})).toBeDefined();
  });
  it("ignores an old call's pending grant after the call changes", async () => {
    const view = mount();
    const originalMint = view.client.mintBinding.bind(view.client);
    let finish!: () => void;
    view.client.mintBinding = async (...args) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return originalMint(...args);
    };
    await grant(view);
    await act(async () => view.rerender(<AgentConnectModal agentClient={view.client} callId="call_2" onClose={() => {}} />));
    await act(async () => finish());
    expect(view.queryByText("fixture-credential-1") === null).toBe(true);
    expect((await view.findByRole("button", { name: "Grant access" }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Exact native session ID") as HTMLInputElement).value).toBe("");
  });
});
