import { describe, it, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import type { Call } from "../lib/appApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

const noopRedirect = () => {};

const SEED: Call[] = [
  { id: "call_2", meetingUrl: "https://zoom.us/j/2", provider: "zoom", status: "JOINING" },
  { id: "call_1", meetingUrl: "https://meet.google.com/abc-defg-hij", provider: "google_meet", status: "PENDING" },
];

describe("Dashboard — fetches and renders the tenant's calls (SPEC §3 Story 1)", () => {
  it("lists calls from GET /calls on load", async () => {
    const client = createFakeAppApiClient({ seedCalls: SEED });
    const { findByText } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    expect(await findByText("https://zoom.us/j/2")).toBeDefined();
    expect(await findByText("https://meet.google.com/abc-defg-hij")).toBeDefined();
    // The list came from a real GET /calls, not just component state.
    expect(client.requests.some((r) => r.path === "/calls" && r.method === "GET")).toBe(true);
  });

  it("shows an empty-state when the tenant has no calls", async () => {
    const client = createFakeAppApiClient();
    const { findByText } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    expect(await findByText(/No calls yet/)).toBeDefined();
  });

  it("adds a newly created call to the list (re-fetched after create)", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    await findByText(/No calls yet/);
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    // The created call shows up in the persisted "Your calls" list.
    expect(await findByText("https://meet.google.com/abc-defg-hij")).toBeDefined();
  });

  it("redirects an anonymous visitor (401 on GET /calls) to /auth", async () => {
    const client = createFakeAppApiClient({
      failListCallsWith: { code: "SAMO-CALL-LIST", message: "no session", status: 401 },
    });
    const seen: string[] = [];
    render(<Dashboard client={client} redirect={(p) => seen.push(p)} />);
    // Let the rejected probe settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["/auth"]);
  });
});

describe("Dashboard — Story-4 URL pre-fill (SPEC §5.2, Story 4)", () => {
  const URL = "https://meet.google.com/abc-defg-hij";

  it("pre-fills the paste input from initialUrl and creates NO call on load", async () => {
    const client = createFakeAppApiClient();
    const { findByLabelText } = render(
      <Dashboard client={client} redirect={noopRedirect} initialUrl={URL} />,
    );
    const input = (await findByLabelText("Meeting link")) as HTMLInputElement;
    expect(input.value).toBe(URL);
    // Returning from a failed join must NOT auto-create a Call row (one action = one row).
    expect(
      client.requests.filter((r) => r.path === "/calls" && r.method === "POST"),
    ).toHaveLength(0);
  });

  it("creates exactly one Call only on explicit re-submit", async () => {
    const client = createFakeAppApiClient();
    const { container, findByLabelText, findByText } = render(
      <Dashboard client={client} redirect={noopRedirect} initialUrl={URL} />,
    );
    await findByLabelText("Meeting link");
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await findByText(URL);
    expect(
      client.requests.filter((r) => r.path === "/calls" && r.method === "POST"),
    ).toHaveLength(1);
  });

  it("leaves the input blank when no initialUrl is given", async () => {
    const client = createFakeAppApiClient();
    const { findByLabelText } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    const input = (await findByLabelText("Meeting link")) as HTMLInputElement;
    expect(input.value).toBe("");
  });
});
