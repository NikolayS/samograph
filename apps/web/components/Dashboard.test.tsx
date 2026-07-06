import { describe, it, expect } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
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

  it("renders a 'Log out' button that clears the session and redirects to /auth", async () => {
    const client = createFakeAppApiClient({ seedCalls: SEED });
    const seen: string[] = [];
    const { findByRole } = render(
      <Dashboard client={client} redirect={(p) => seen.push(p)} />,
    );
    const button = await findByRole("button", { name: /log out/i });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(seen).toEqual(["/auth"]);
    expect(client.requests.some((r) => r.path === "/auth/logout" && r.method === "POST")).toBe(true);
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

describe("Dashboard — failed calls display their error reason (SPEC §5.16, Story 4)", () => {
  const FAILED: Call[] = [
    {
      id: "call_9",
      meetingUrl: "https://meet.google.com/bad-code-xxx",
      provider: "google_meet",
      status: "COULD_NOT_JOIN",
      statusReason: "meeting_not_found",
    },
    {
      id: "call_8",
      meetingUrl: "https://zoom.us/j/8",
      provider: "zoom",
      status: "COULD_NOT_RECORD",
      statusReason: "recording_permission_denied_by_host",
    },
    { id: "call_7", meetingUrl: "https://zoom.us/j/7", provider: "zoom", status: "IN_CALL" },
  ];

  it("shows the §5.16 reason next to a failed call's status", async () => {
    const client = createFakeAppApiClient({ seedCalls: FAILED });
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    // Exact §5.16 copy, reason included: "Couldn't join — <Recall reason>."
    expect(await findByText("Couldn't join — meeting_not_found.")).toBeDefined();
    expect(
      await findByText("Couldn't start recording — recording_permission_denied_by_host."),
    ).toBeDefined();
  });

  it("a COULD_NOT_JOIN call with no reason still gets the fallback copy (never silent)", async () => {
    const client = createFakeAppApiClient({
      seedCalls: [
        {
          id: "call_5",
          meetingUrl: "https://zoom.us/j/5",
          provider: "zoom",
          status: "COULD_NOT_JOIN",
        },
      ],
    });
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    expect(await findByText("Couldn't join — the meeting couldn't be reached.")).toBeDefined();
  });

  it("shows NO error copy for a healthy call", async () => {
    const client = createFakeAppApiClient({ seedCalls: FAILED });
    const { findByText, queryByText } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    await findByText("https://zoom.us/j/7");
    expect(queryByText(/Couldn't join.*zoom\.us\/j\/7/)).toBeNull();
  });

  it("links each call to its per-call page carrying ?url= (COULD_NOT_JOIN reaches Try-again, Story 4)", async () => {
    const client = createFakeAppApiClient({ seedCalls: FAILED });
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    const anchor = (await findByText("https://meet.google.com/bad-code-xxx")).closest("a");
    expect(anchor).not.toBeNull();
    // The per-call page (OwnerCallView) owns "Try again"; ?url= carries the
    // original meeting URL so Try-again can pre-fill the dashboard input.
    expect(anchor?.getAttribute("href")).toBe(
      `/calls/call_9?url=${encodeURIComponent("https://meet.google.com/bad-code-xxx")}`,
    );
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
