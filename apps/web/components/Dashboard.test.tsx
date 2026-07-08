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

describe("Dashboard — each call row is an obvious transcript link (affordance)", () => {
  it("renders the whole row as a link to the per-call page with a clear 'View transcript' CTA", async () => {
    const client = createFakeAppApiClient({
      seedCalls: [
        { id: "call_e", meetingUrl: "https://zoom.us/j/e", provider: "zoom", status: "ENDED" },
      ],
    });
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    const row = (await findByText("https://zoom.us/j/e")).closest("a");
    expect(row).not.toBeNull();
    // Whole row is the link into the transcript page.
    expect(row?.getAttribute("href")).toBe(
      `/calls/call_e?url=${encodeURIComponent("https://zoom.us/j/e")}`,
    );
    // Explicit, inviting affordance so a first-time user knows to tap it.
    expect(row?.textContent).toContain("View transcript");
    // Accessible: the link carries its own name.
    expect(row?.getAttribute("aria-label")).toBeTruthy();
  });

  it("a LIVE call (IN_CALL) shows a prominent pulsing 'Live — watch transcript' cue", async () => {
    const client = createFakeAppApiClient({
      seedCalls: [
        { id: "call_live", meetingUrl: "https://zoom.us/j/live", provider: "zoom", status: "IN_CALL" },
      ],
    });
    const { findByText, container } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    // The live cue invites opening the transcript to watch in real time.
    expect(await findByText(/live — watch transcript/i)).toBeDefined();
    // A live indicator dot is present (styled as the pulsing "●").
    expect(container.querySelector(".samograph-call-live-dot")).not.toBeNull();
    // The row still links into the per-call page.
    const row = (await findByText("https://zoom.us/j/live")).closest("a");
    expect(row?.getAttribute("href")).toBe(
      `/calls/call_live?url=${encodeURIComponent("https://zoom.us/j/live")}`,
    );
  });

  it("a terminal-failure row keeps its reason and does NOT show a transcript invite", async () => {
    const client = createFakeAppApiClient({
      seedCalls: [
        {
          id: "call_f",
          meetingUrl: "https://zoom.us/j/f",
          provider: "zoom",
          status: "COULD_NOT_RECORD",
          statusReason: "recording_permission_denied_by_host",
        },
      ],
    });
    const { findByText, queryByText } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    // §5.16 reason is preserved.
    expect(
      await findByText("Couldn't start recording — recording_permission_denied_by_host."),
    ).toBeDefined();
    // A failure row must not be dressed up as a transcript invite.
    expect(queryByText(/view transcript/i)).toBeNull();
    expect(queryByText(/watch transcript/i)).toBeNull();
  });

  it("a COULD_NOT_JOIN row offers 'Try again' rather than a transcript invite", async () => {
    const client = createFakeAppApiClient({
      seedCalls: [
        {
          id: "call_j",
          meetingUrl: "https://zoom.us/j/j",
          provider: "zoom",
          status: "COULD_NOT_JOIN",
          statusReason: "meeting_not_found",
        },
      ],
    });
    const { findByText, queryByText } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    // Keeps the existing Story-4 "Try again" affordance (the per-call page owns it).
    expect(await findByText(/try again/i)).toBeDefined();
    expect(queryByText(/view transcript/i)).toBeNull();
  });
});

describe("Dashboard — Active vs Past grouping (Sprint-3 polish, SPEC §3)", () => {
  const MIXED: Call[] = [
    { id: "c_live", meetingUrl: "https://zoom.us/j/live", provider: "zoom", status: "IN_CALL" },
    { id: "c_pending", meetingUrl: "https://zoom.us/j/pending", provider: "zoom", status: "PENDING" },
    { id: "c_ended", meetingUrl: "https://zoom.us/j/ended", provider: "zoom", status: "ENDED" },
    {
      id: "c_norec",
      meetingUrl: "https://zoom.us/j/norec",
      provider: "zoom",
      status: "COULD_NOT_RECORD",
      statusReason: "recording_permission_denied_by_host",
    },
    { id: "c_removed", meetingUrl: "https://zoom.us/j/removed", provider: "zoom", status: "BOT_REMOVED" },
  ];

  it("renders two clearly-labelled groups: 'Active calls' and 'Past calls'", async () => {
    const client = createFakeAppApiClient({ seedCalls: MIXED });
    const { findByRole } = render(<Dashboard client={client} redirect={noopRedirect} />);
    expect(await findByRole("heading", { name: "Active calls" })).toBeDefined();
    expect(await findByRole("heading", { name: "Past calls" })).toBeDefined();
  });

  it("places PENDING/JOINING/IN_CALL under Active and terminal calls under Past", async () => {
    const client = createFakeAppApiClient({ seedCalls: MIXED });
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    const active = (await findByText("Active calls")).closest("section");
    const past = (await findByText("Past calls")).closest("section");
    if (!active || !past) throw new Error("missing group sections");
    // Active group: live + pending only.
    expect(active.textContent).toContain("https://zoom.us/j/live");
    expect(active.textContent).toContain("https://zoom.us/j/pending");
    expect(active.textContent).not.toContain("https://zoom.us/j/ended");
    expect(active.textContent).not.toContain("https://zoom.us/j/norec");
    // Past group: ended + terminal failures only.
    expect(past.textContent).toContain("https://zoom.us/j/ended");
    expect(past.textContent).toContain("https://zoom.us/j/norec");
    expect(past.textContent).toContain("https://zoom.us/j/removed");
    expect(past.textContent).not.toContain("https://zoom.us/j/live");
  });

  it("omits the 'Past calls' heading entirely when every call is active", async () => {
    const client = createFakeAppApiClient({
      seedCalls: [{ id: "c1", meetingUrl: "https://zoom.us/j/a", provider: "zoom", status: "IN_CALL" }],
    });
    const { findByRole, queryByRole } = render(
      <Dashboard client={client} redirect={noopRedirect} />,
    );
    expect(await findByRole("heading", { name: "Active calls" })).toBeDefined();
    expect(queryByRole("heading", { name: "Past calls" })).toBeNull();
  });

  it("renders the bespoke COULD_NOT_RECORD hint in the Past group", async () => {
    const client = createFakeAppApiClient({ seedCalls: MIXED });
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    expect(
      await findByText("Check the meeting's recording permissions, then add the call again."),
    ).toBeDefined();
  });

  it("renders the bespoke BOT_REMOVED hint in the Past group", async () => {
    const client = createFakeAppApiClient({ seedCalls: MIXED });
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    expect(await findByText("A host removed samograph from the meeting.")).toBeDefined();
  });
});

describe("Dashboard — first-run empty & loading states (Sprint-3 polish)", () => {
  it("shows an accessible loading state on first paint", () => {
    const client = createFakeAppApiClient({ seedCalls: SEED });
    const { getByRole } = render(<Dashboard client={client} redirect={noopRedirect} />);
    // Before the GET /calls promise settles, a status region announces loading.
    const status = getByRole("status");
    expect(status.textContent).toBe("Loading your dashboard…");
  });

  it("gives first-run guidance (not just 'No calls yet') when there are no calls", async () => {
    const client = createFakeAppApiClient();
    const { findByText } = render(<Dashboard client={client} redirect={noopRedirect} />);
    expect(await findByText(/No calls yet/)).toBeDefined();
    // Concrete first-call guidance, so a new user knows exactly what to do.
    expect(
      await findByText(
        "Paste a Zoom or Google Meet link above to add samograph to your first call.",
      ),
    ).toBeDefined();
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
