import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage.tsx";
import { CalendarConnectionCard } from "./CalendarConnectionCard.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { installDom } from "../test/setup.tsx";
installDom();

describe("Settings Calendar connection", () => {
  it("optimistically toggles auto-record and rolls back on failure", async () => {
    const client = createFakeAppApiClient({ seedCalendarStatus: { provider: "google", state: "connected", connectedAt: null, lastSyncAt: null, lastSyncErrorAt: null, autoJoin: false }, failUpdateCalendarAutoJoinWith: { code: "failed", message: "failed" } });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);
    const control = await view.findByRole("switch", { name: /auto-record my meetings/i }) as HTMLInputElement;
    fireEvent.click(control);
    expect(control.checked).toBe(true);
    await waitFor(() => expect(control.checked).toBe(false));
    expect(client.requests).toContainEqual({ path: "/calendar/connection", method: "PATCH", body: { auto_join: true } });
    expect((await view.findByRole("alert")).textContent).toContain("Auto-record couldn’t be updated");
  });
  it("formats last sync with the supplied locale and time zone", async () => {
    const client = createFakeAppApiClient({ seedCalendarStatus: { provider: "google", state: "connected", connectedAt: "2026-08-20T18:30:00Z", lastSyncAt: "2026-08-20T18:35:00Z", lastSyncErrorAt: null } });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} locale="en-US" timeZone="UTC" />);

    expect((await view.findByText(/^Last synced /)).textContent).toBe("Last synced 8/20/2026, 6:35:00 PM");
  });

  it.each([
    "javascript:alert(1)",
    "https://evil.example/o/oauth2/v2/auth",
    "http://accounts.google.com/o/oauth2/v2/auth",
  ])("rejects an unsafe calendar authorization URL: %s", async (authorizationUrl) => {
    const assign = mock(() => {});
    Object.defineProperty(window.location, "assign", { configurable: true, value: assign });
    const client = createFakeAppApiClient({ seedCalendarStatus: { provider: "google", state: "not_connected", connectedAt: null, lastSyncAt: null, lastSyncErrorAt: null } });
    client.startCalendarConnect = async () => ({ authorizationUrl });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);

    fireEvent.click(await view.findByRole("button", { name: "Connect Google Calendar" }));

    expect((await view.findByRole("alert")).textContent).toBe("Something went wrong connecting Google Calendar.");
    expect(assign).not.toHaveBeenCalled();
    view.unmount();
  });

  it("navigates to an exact Google Accounts HTTPS authorization URL", async () => {
    const assign = mock(() => {});
    Object.defineProperty(window.location, "assign", { configurable: true, value: assign });
    const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&scope=calendar";
    const client = createFakeAppApiClient({ seedCalendarStatus: { provider: "google", state: "not_connected", connectedAt: null, lastSyncAt: null, lastSyncErrorAt: null } });
    client.startCalendarConnect = async () => ({ authorizationUrl });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);

    fireEvent.click(await view.findByRole("button", { name: "Connect Google Calendar" }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith(authorizationUrl);
    view.unmount();
  });

  it("fails closed when calendar capability is absent", async () => {
    const view = render(<SettingsPage client={createFakeAppApiClient()} redirect={() => {}} />);
    await view.findByRole("heading", { name: "Settings" });
    expect(view.queryByRole("region", { name: "Google Calendar" })).toBeNull();
  });

  it("renders status and keeps calendar controls out of settings PUT", async () => {
    const client = createFakeAppApiClient({ googleCalendarEnabled: true, seedCalendarStatus: { provider: "google", state: "not_connected", connectedAt: null, lastSyncAt: null, lastSyncErrorAt: null } });
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    expect(await view.findByText("Show upcoming meetings from your calendar.")).toBeDefined();
    fireEvent.change(view.getByRole("combobox", { name: /language/i }), { target: { value: "de" } });
    fireEvent.click(view.getByRole("button", { name: "Save settings" }));
    await view.findByText("Settings saved.");
    expect(client.requests.find((r) => r.path === "/settings" && r.method === "PUT")?.body).not.toHaveProperty("calendar");
  });

  it("disconnects only after confirmation and refreshes to not connected", async () => {
    const client = createFakeAppApiClient({ googleCalendarEnabled: true, seedCalendarStatus: { provider: "google", state: "connected", connectedAt: "2026-08-20T18:30:00Z", lastSyncAt: "2026-08-20T18:35:00Z", lastSyncErrorAt: null } });
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    fireEvent.click(await view.findByRole("button", { name: "Disconnect" }));
    const dialog = await view.findByRole("dialog", { name: /disconnect/i });
    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Disconnect");
    if (!confirm) throw new Error("missing in-dialog Disconnect button");
    fireEvent.click(confirm);
    await waitFor(() => expect(client.requests.filter((r) => r.path === "/calendar/connection" && r.method === "DELETE")).toHaveLength(1));
    expect(await view.findByRole("button", { name: "Connect Google Calendar" })).toBeDefined();
    expect(document.activeElement).not.toBe(document.body);
  });

  // AUDIT-2026-09-04 §4 / PLAN.md PR 3: the pair used to be two stretched grid
  // items of `.samograph-signin` (656px wide, stacked). They belong to ONE
  // action row.
  it("puts the Reconnect/Disconnect pair in a single action row", async () => {
    const client = createFakeAppApiClient({
      seedCalendarStatus: { provider: "google", state: "broken", connectedAt: "2026-08-20T18:30:00Z", lastSyncAt: null, lastSyncErrorAt: "2026-08-20T18:35:00Z" },
    });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);

    const reconnect = await view.findByRole("button", { name: "Reconnect" });
    const disconnect = view.getByRole("button", { name: "Disconnect" });
    expect(reconnect.parentElement?.className).toBe("samograph-actions");
    expect(disconnect.parentElement).toBe(reconnect.parentElement);
    expect(view.container.querySelector(".samograph-signin")).toBeNull();
    view.unmount();
  });

  it("clears a failed reconnect error when disconnect succeeds", async () => {
    const client = createFakeAppApiClient({
      seedCalendarStatus: { provider: "google", state: "broken", connectedAt: "2026-08-20T18:30:00Z", lastSyncAt: null, lastSyncErrorAt: "2026-08-20T18:35:00Z" },
      failStartCalendarConnectWith: { code: "unexpected", message: "failed" },
    });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);

    fireEvent.click(await view.findByRole("button", { name: "Reconnect" }));
    expect((await view.findByRole("alert")).textContent).toBe("Google Calendar couldn’t be connected. Please try again.");
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    const dialog = await view.findByRole("dialog", { name: /disconnect/i });
    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Disconnect");
    if (!confirm) throw new Error("missing in-dialog Disconnect button");
    fireEvent.click(confirm);

    expect(await view.findByRole("button", { name: "Connect Google Calendar" })).toBeDefined();
    expect(view.queryByText("Google Calendar couldn’t be connected. Please try again.")).toBeNull();
  });

  it("uses an accessible in-page disconnect confirmation with focus, Escape, and focus return", async () => {
    const confirmSpy = mock(() => true);
    window.confirm = confirmSpy;
    const client = createFakeAppApiClient({ seedCalendarStatus: { provider: "google", state: "connected", connectedAt: "2026-08-20T18:30:00Z", lastSyncAt: null, lastSyncErrorAt: null } });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);
    const trigger = await view.findByRole("button", { name: "Disconnect" }) as HTMLButtonElement;
    fireEvent.click(trigger);

    const dialog = await view.findByRole("dialog", { name: /disconnect/i });
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
    const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Disconnect");
    if (!cancel || !confirm) throw new Error("missing confirmation buttons");
    expect(document.activeElement).toBe(cancel);
    expect(confirmSpy).toHaveBeenCalledTimes(0);
    expect(cancel.className).toContain("samograph-btn--secondary");
    expect(confirm.className).toContain("samograph-btn--danger");
    expect(confirm.className).toContain("samograph-btn--solid");

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(view.getByRole("dialog", { name: /disconnect/i })).toBe(dialog);

    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(view.queryByRole("dialog", { name: /disconnect/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(client.requests.some((r) => r.path === "/calendar/connection" && r.method === "DELETE")).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(0);
  });

  it("gives calendar actions their variants", async () => {
    const client = createFakeAppApiClient({ seedCalendarStatus: { provider: "google", state: "broken", connectedAt: "2026-08-20T18:30:00Z", lastSyncAt: null, lastSyncErrorAt: "2026-08-20T18:35:00Z" } });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);
    expect((await view.findByRole("button", { name: "Reconnect" })).className).toContain("samograph-btn--secondary");
    expect(view.getByRole("button", { name: "Disconnect" }).className).toContain("samograph-btn--danger");
  });

  it("uses a secondary Connect Google Calendar action", async () => {
    const client = createFakeAppApiClient({ seedCalendarStatus: { provider: "google", state: "not_connected", connectedAt: null, lastSyncAt: null, lastSyncErrorAt: null } });
    const view = render(<CalendarConnectionCard client={client} onAuthFailure={() => {}} />);
    expect((await view.findByRole("button", { name: "Connect Google Calendar" })).className).toContain("samograph-btn--secondary");
  });

  it("uses error alert semantics for failure and success status semantics for success", async () => {
    window.history.replaceState({}, "", "/?calendar_error=SAMO-AUTH-001");
    const failed = render(<CalendarConnectionCard client={createFakeAppApiClient()} onAuthFailure={() => {}} />);
    const alert = await failed.findByRole("alert");
    expect(alert.className).toContain("samograph-alert samograph-alert--error");
    failed.unmount();

    window.history.replaceState({}, "", "/?calendar=connected");
    const succeeded = render(<CalendarConnectionCard client={createFakeAppApiClient()} onAuthFailure={() => {}} />);
    const status = await succeeded.findByRole("status");
    expect(status.textContent).toBe("Google Calendar connected.");
    expect(status.className).toContain("samograph-alert samograph-alert--success");
  });
});
