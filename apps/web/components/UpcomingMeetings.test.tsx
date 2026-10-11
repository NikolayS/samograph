import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { Dashboard } from "./Dashboard.tsx";
import { UpcomingMeetings } from "./UpcomingMeetings.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { AppApiError } from "../lib/appApiClient.ts";
import { installDom } from "../test/setup.tsx";
installDom();

describe("Dashboard upcoming meetings", () => {
  it("shows auto state and toggles a meeting exclusion", async () => {
    const client = createFakeAppApiClient({ seedCalendarMeetings: { connectionState: "connected", autoJoin: true, lastSyncAt: null, meetings: [{ id: "event/1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", organizerEmail: null, attendeeResponse: "accepted", autoJoinExcluded: false }] } });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    expect(await view.findByText("Auto")).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "Skip auto-record for Planning" }));
    expect(await view.findByRole("button", { name: "Undo skip auto-record for Planning" })).toBeDefined();
    expect(client.requests).toContainEqual({ path: "/calendar/meetings/event%2F1", method: "PATCH", body: { excluded: true } });
    expect(view.queryByRole("button", { name: "Add samograph to Planning" })).toBeNull();
  });

  it("rolls an optimistic exclusion toggle back when the request is rejected", async () => {
    const client = createFakeAppApiClient({
      seedCalendarMeetings: { connectionState: "connected", autoJoin: true, lastSyncAt: null, meetings: [{ id: "event-1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", organizerEmail: null, attendeeResponse: "accepted", autoJoinExcluded: false }] },
    });
    let rejectUpdate!: (error: Error) => void;
    client.setCalendarMeetingExcluded = mock(() => new Promise<{ id: string; excluded: boolean }>((_resolve, reject) => { rejectUpdate = reject; }));
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    fireEvent.click(await view.findByRole("button", { name: "Skip auto-record for Planning" }));
    expect(await view.findByRole("button", { name: "Undo skip auto-record for Planning" })).toBeDefined();
    rejectUpdate(new Error("failed"));
    expect(await view.findByRole("button", { name: "Skip auto-record for Planning" })).toBeDefined();
    expect((await view.findByRole("alert")).textContent).toBe("Auto-record couldn’t be updated. Try again.");
  });

  it("syncs the per-row exclusion state when a refreshed snapshot changes the prop", async () => {
    const meeting = { id: "event-1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet" as const, organizerEmail: null, attendeeResponse: "accepted" as const };
    const first = createFakeAppApiClient({ seedCalendarMeetings: { connectionState: "connected", autoJoin: true, lastSyncAt: null, meetings: [{ ...meeting, autoJoinExcluded: false }] } });
    const second = createFakeAppApiClient({ seedCalendarMeetings: { connectionState: "connected", autoJoin: true, lastSyncAt: null, meetings: [{ ...meeting, autoJoinExcluded: true }] } });
    const view = render(<UpcomingMeetings client={first} onAuthFailure={() => {}} />);
    expect(await view.findByRole("button", { name: "Skip auto-record for Planning" })).toBeDefined();
    view.rerender(<UpcomingMeetings client={second} onAuthFailure={() => {}} />);
    expect(await view.findByRole("button", { name: "Undo skip auto-record for Planning" })).toBeDefined();
  });
  it("keeps an optimistic toggle during prop refreshes and applies the confirmed response", async () => {
    const meeting = { id: "event-1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet" as const, organizerEmail: null, attendeeResponse: "accepted" as const };
    const clientFor = (autoJoinExcluded: boolean) => createFakeAppApiClient({ seedCalendarMeetings: { connectionState: "connected", autoJoin: true, lastSyncAt: null, meetings: [{ ...meeting, autoJoinExcluded }] } });
    const first = clientFor(false), refreshed = clientFor(true), stale = clientFor(false);
    let resolveUpdate!: (value: { id: string; excluded: boolean }) => void;
    first.setCalendarMeetingExcluded = mock(() => new Promise((resolve) => { resolveUpdate = resolve; })) as unknown as typeof first.setCalendarMeetingExcluded;
    const view = render(<UpcomingMeetings client={first} onAuthFailure={() => {}} />);

    fireEvent.click(await view.findByRole("button", { name: "Skip auto-record for Planning" }));
    view.rerender(<UpcomingMeetings client={refreshed} onAuthFailure={() => {}} />);
    await view.findByRole("button", { name: "Undo skip auto-record for Planning" });
    view.rerender(<UpcomingMeetings client={stale} onAuthFailure={() => {}} />);
    await waitFor(() => expect(stale.requests.some((request) => request.path === "/calendar/meetings?limit=20")).toBe(true));
    await Promise.resolve();
    resolveUpdate({ id: meeting.id, excluded: true });

    await waitFor(() => expect(view.getByRole("button").getAttribute("aria-busy")).toBe("false"));
    expect(view.getByRole("button", { name: "Undo skip auto-record for Planning" })).toBeDefined();
  });
  it("shows one primary Connect CTA in the available-calendar empty state", async () => {
    const client = createFakeAppApiClient({
      googleCalendarEnabled: true,
      seedCalendarMeetings: { connectionState: "not_connected", lastSyncAt: null, meetings: [] },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    const title = await view.findByText("No calendar connected.");
    const empty = title.closest(".samograph-empty-state");
    expect(title.classList.contains("samograph-empty-title")).toBe(true);
    expect(empty).not.toBeNull();
    expect(empty?.querySelectorAll("a, button")).toHaveLength(1);
    const connect = view.getByRole("button", { name: "Connect Google Calendar" });
    expect(empty?.contains(connect)).toBe(true);
    expect(connect.classList.contains("samograph-btn")).toBe(true);
    expect(connect.classList.contains("samograph-btn--primary")).toBe(true);
    expect(view.queryByRole("link", { name: "Manage in Settings" })).toBeNull();
  });

  it("shows one secondary Settings CTA when calendar capability is unavailable", async () => {
    const client = createFakeAppApiClient({
      googleCalendarEnabled: false,
      seedCalendarMeetings: { connectionState: "not_connected", lastSyncAt: null, meetings: [] },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    const title = await view.findByText("No calendar connected.");
    const empty = title.closest(".samograph-empty-state");
    expect(empty).not.toBeNull();
    expect(empty?.querySelectorAll("a, button")).toHaveLength(1);
    const settings = view.getByRole("link", { name: "Manage in Settings" });
    expect(settings.classList.contains("samograph-btn")).toBe(true);
    expect(settings.classList.contains("samograph-btn--secondary")).toBe(true);
  });

  it("renders the connected no-meetings empty state", async () => {
    const client = createFakeAppApiClient({
      seedCalendarMeetings: { connectionState: "connected", lastSyncAt: null, meetings: [] },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    const title = await view.findByText("No upcoming meetings.");
    expect(title.classList.contains("samograph-empty-title")).toBe(true);
    expect(title.closest(".samograph-empty-state")).not.toBeNull();
  });

  it("truncates a long meeting title but keeps the full text in its title attribute", async () => {
    const long = "Quarterly planning sync with the whole platform + data + SRE org";
    const client = createFakeAppApiClient({ seedCalendarMeetings: {
      connectionState: "connected", lastSyncAt: null, meetings: [
        { id: "1", title: long, startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: null, meetingProvider: null, organizerEmail: null, attendeeResponse: "accepted" },
      ],
    } });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    const title = await view.findByText(long);
    expect(title.getAttribute("title")).toBe(long);
  });

  it("adds samograph to a meeting, guards the action while pending, and links the created call", async () => {
    const client = createFakeAppApiClient({ seedCalendarMeetings: {
      connectionState: "connected", lastSyncAt: null, meetings: [
        { id: "1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", organizerEmail: null, attendeeResponse: "accepted" },
      ],
    } });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    const title = await view.findByText("Planning");
    const item = title.closest("li.samograph-meeting-item");
    expect(title.classList.contains("samograph-meeting-title")).toBe(true);
    expect(item?.querySelector("span.samograph-meeting-meta")).not.toBeNull();
    let resolveCreate!: (call: Awaited<ReturnType<typeof client.createCall>>) => void;
    client.createCall = mock(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const add = view.getByRole("button", { name: "Add samograph to Planning" });
    fireEvent.click(add);
    expect(add.getAttribute("aria-busy")).toBe("true");
    expect(add.hasAttribute("disabled")).toBe(true);
    resolveCreate({ id: "call-1", meetingUrl: "https://meet.google.com/abc-defg-hij", provider: "google_meet", status: "PENDING" });
    const created = await view.findByRole("link", { name: "View Planning call" });
    expect(created.getAttribute("href")).toBe("/calls/call-1");
    expect(client.createCall).toHaveBeenCalledWith({ meetingUrl: "https://meet.google.com/abc-defg-hij" });
    const open = view.getByRole("link", { name: "Open Planning" });
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("notifies the dashboard after adding samograph so its calls can be refreshed", async () => {
    const onCreated = mock(() => {});
    const client = createFakeAppApiClient({ seedCalendarMeetings: {
      connectionState: "connected", lastSyncAt: null, meetings: [
        { id: "1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", organizerEmail: null, attendeeResponse: "accepted" },
      ],
    } });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} onCreated={onCreated} />);

    fireEvent.click(await view.findByRole("button", { name: "Add samograph to Planning" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    }));
  });

  it("hands session-invalid create-call failures to the auth failure path", async () => {
    const onAuthFailure = mock(() => {});
    const client = createFakeAppApiClient({
      seedCalendarMeetings: { connectionState: "connected", lastSyncAt: null, meetings: [
        { id: "1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://zoom.us/j/123456789", meetingProvider: "zoom", organizerEmail: null, attendeeResponse: "accepted" },
      ] },
      failCreateCallWith: { code: "SAMO-AUTH-005", message: "Session invalid.", status: 401 },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={onAuthFailure} />);

    fireEvent.click(await view.findByRole("button", { name: "Add samograph to Planning" }));

    await waitFor(() => expect(onAuthFailure).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("shows the create-call error and lets the user retry", async () => {
    const client = createFakeAppApiClient({
      seedCalendarMeetings: { connectionState: "connected", lastSyncAt: null, meetings: [
        { id: "1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://zoom.us/j/123456789", meetingProvider: "zoom", organizerEmail: null, attendeeResponse: "accepted" },
      ] },
      failCreateCallWith: { code: "SAMO-CALL-FAILED", message: "Could not create call." },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    fireEvent.click(await view.findByRole("button", { name: "Add samograph to Planning" }));
    expect((await view.findByRole("alert")).textContent).toBe("Could not create call.");
    expect(view.getByRole("button", { name: "Add samograph to Planning" }).hasAttribute("disabled")).toBe(false);
  });

  it("links to the existing call without an alert on SAMO-CALL-ACTIVE", async () => {
    const client = createFakeAppApiClient({ seedCalendarMeetings: { connectionState: "connected", lastSyncAt: null, meetings: [
      { id: "1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://zoom.us/j/123456789", meetingProvider: "zoom", organizerEmail: null, attendeeResponse: "accepted" },
    ] } });
    client.createCall = async () => {
      throw new AppApiError("SAMO-CALL-ACTIVE", "Request failed.", false, 409, "active-2");
    };
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);
    fireEvent.click(await view.findByRole("button", { name: "Add samograph to Planning" }));
    const link = await view.findByRole("link", { name: "samograph is already in this call" });
    expect(link.getAttribute("href")).toBe("/calls/active-2");
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("starts Google Calendar connect from the dashboard when the capability is available", async () => {
    const assign = mock(() => {});
    Object.defineProperty(window.location, "assign", { configurable: true, value: assign });
    const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&scope=calendar";
    const client = createFakeAppApiClient({
      googleCalendarEnabled: true,
      calendarAuthorizationUrl: authorizationUrl,
      seedCalendarMeetings: { connectionState: "not_connected", lastSyncAt: null, meetings: [] },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);

    const connect = await view.findByRole("button", { name: "Connect Google Calendar" });
    expect(view.queryByRole("link", { name: "Connect Google Calendar" })).toBeNull();
    fireEvent.click(connect);

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith(authorizationUrl);
    expect(client.requests.filter((request) => request.path === "/calendar/connect/start" && request.method === "POST")).toHaveLength(1);
  });

  it("marks the Connect Google Calendar button busy while connect is pending", async () => {
    const client = createFakeAppApiClient({
      googleCalendarEnabled: true,
      seedCalendarMeetings: { connectionState: "not_connected", lastSyncAt: null, meetings: [] },
    });
    client.startCalendarConnect = () => new Promise(() => {});
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);

    fireEvent.click(await view.findByRole("button", { name: "Connect Google Calendar" }));

    const connecting = await view.findByRole("button", { name: "Connecting…" });
    expect(connecting.getAttribute("aria-busy")).toBe("true");
  });

  it("shows the guarded connect error inline and does not navigate for javascript URLs", async () => {
    const assign = mock(() => {});
    Object.defineProperty(window.location, "assign", { configurable: true, value: assign });
    const client = createFakeAppApiClient({
      googleCalendarEnabled: true,
      calendarAuthorizationUrl: "javascript:alert(1)",
      seedCalendarMeetings: { connectionState: "not_connected", lastSyncAt: null, meetings: [] },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);

    fireEvent.click(await view.findByRole("button", { name: "Connect Google Calendar" }));

    expect((await view.findByRole("alert")).textContent).toBe("Something went wrong connecting Google Calendar.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("falls back to Settings when Google Calendar capability is unavailable", async () => {
    const client = createFakeAppApiClient({
      googleCalendarEnabled: false,
      seedCalendarMeetings: { connectionState: "not_connected", lastSyncAt: null, meetings: [] },
    });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);

    const settings = await view.findByRole("link", { name: "Manage in Settings" });
    expect(settings.getAttribute("href")).toBe("/settings");
    expect(view.queryByRole("button", { name: "Connect Google Calendar" })).toBeNull();
  });

  it("falls back to Settings when the calendar capability probe rejects", async () => {
    const client = createFakeAppApiClient({
      seedCalendarMeetings: { connectionState: "not_connected", lastSyncAt: null, meetings: [] },
    });
    client.authProviders = async () => { throw new Error("transient probe failure"); };
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} />);

    const settings = await view.findByRole("link", { name: "Manage in Settings" });
    await Promise.resolve();
    expect(settings.getAttribute("href")).toBe("/settings");
    expect(view.queryByRole("button", { name: "Connect Google Calendar" })).toBeNull();
  });

  it("formats meeting times with the supplied locale and time zone", async () => {
    const client = createFakeAppApiClient({ seedCalendarMeetings: { connectionState: "connected", lastSyncAt: null, meetings: [
      { id: "utc", title: "UTC meeting", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: null, meetingProvider: null, organizerEmail: null, attendeeResponse: null },
    ] } });
    const view = render(<UpcomingMeetings client={client} onAuthFailure={() => {}} locale="en-US" timeZone="UTC" />);

    expect((await view.findByText(/30 min/)).textContent).toBe("8/21/2026, 5:00:00 PM · 30 min");
  });

  it("renders meetings independently with safe Open links and no actions for declined/unlinked rows", async () => {
    const client = createFakeAppApiClient({ seedCalendarMeetings: { connectionState: "connected", lastSyncAt: null, meetings: [
      { id: "1", title: "Planning", startsAt: "2026-08-21T17:00:00Z", endsAt: "2026-08-21T17:30:00Z", allDay: false, meetingUrl: "https://meet.google.com/abc-defg-hij", meetingProvider: "google_meet", organizerEmail: null, attendeeResponse: "accepted" },
      { id: "2", title: "Declined", startsAt: "2026-08-21T18:00:00Z", endsAt: "2026-08-21T18:30:00Z", allDay: false, meetingUrl: "https://zoom.us/j/2", meetingProvider: "zoom", organizerEmail: null, attendeeResponse: "declined" },
      { id: "3", title: "No link", startsAt: "2026-08-21T19:00:00Z", endsAt: "2026-08-21T20:00:00Z", allDay: false, meetingUrl: null, meetingProvider: null, organizerEmail: null, attendeeResponse: null },
      { id: "4", title: "Data URL", startsAt: "2026-08-21T20:00:00Z", endsAt: "2026-08-21T20:30:00Z", allDay: false, meetingUrl: "data:text/html,<script>alert(1)</script>", meetingProvider: null, organizerEmail: null, attendeeResponse: "accepted" },
      { id: "5", title: "JavaScript URL", startsAt: "2026-08-21T21:00:00Z", endsAt: "2026-08-21T21:30:00Z", allDay: false, meetingUrl: "javascript:alert(1)", meetingProvider: null, organizerEmail: null, attendeeResponse: "accepted" },
    ] } });
    const view = render(<Dashboard client={client} redirect={() => {}} />);
    const open = await view.findByRole("link", { name: "Open Planning" });
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(view.queryByRole("link", { name: /Open Declined/ })).toBeNull();
    expect(view.queryByRole("link", { name: "Open Data URL" })).toBeNull();
    expect(view.queryByRole("link", { name: "Open JavaScript URL" })).toBeNull();
    expect(await view.findByText("No link")).toBeDefined();
    expect(view.getAllByText("Declined")[0]?.closest("li")?.getAttribute("data-declined")).toBe("true");
  });

  it("calendar failure never hides existing calls", async () => {
    const client = createFakeAppApiClient({ seedCalls: [{ id: "c", meetingUrl: "https://zoom.us/j/9", provider: "zoom", status: "PENDING" }], failListCalendarMeetingsWith: { code: "SAMO-CALENDAR-006", message: "no" } });
    const view = render(<Dashboard client={client} redirect={() => {}} />);
    expect(await view.findByText("https://zoom.us/j/9")).toBeDefined();
    expect(await view.findByText("Upcoming meetings couldn’t be refreshed. Please try again.")).toBeDefined();
  });
});
