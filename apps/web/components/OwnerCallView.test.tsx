import { describe, it, expect } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import { OwnerCallView } from "./OwnerCallView.tsx";
import { createFakeTranscriptStreamClient } from "../lib/fakeTranscriptStreamClient.ts";
import { createFakeShareApiClient } from "../lib/fakeShareApiClient.ts";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import type { CallDetail } from "../lib/transcriptStreamClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

const TS = "2026-06-29 10:00:00";
const MEETING_URL = "https://meet.google.com/abc-defg-hij";

// Default PENDING so the async `fetchCallDetail` seed is a deterministic no-op
// (initial state is already PENDING) — these tests drive status through the
// stream. A non-PENDING seed left un-awaited would schedule a React render task
// that outlives happy-dom's teardown ("window is not defined").
function detail(over: Partial<CallDetail> = {}): CallDetail {
  return { id: "call_1", status: "PENDING", degraded: false, ...over };
}

function renderOwner(
  over: { redirect?: (p: string) => void } = {},
) {
  const stream = createFakeTranscriptStreamClient({ callDetail: detail() });
  const share = createFakeShareApiClient();
  const app = createFakeAppApiClient();
  const redirected: string[] = [];
  const utils = render(
    <OwnerCallView
      streamClient={stream}
      shareClient={share}
      appClient={app}
      callId="call_1"
      meetingUrl={MEETING_URL}
      redirect={over.redirect ?? ((p) => redirected.push(p))}
    />,
  );
  return { stream, share, app, redirected, ...utils };
}

describe("OwnerCallView — owner per-call page (SPEC §4.1, Stories 1/2/4)", () => {
  it("renders the live transcript + status with an owner Share control", () => {
    const { stream, getByText, getByRole } = renderOwner();
    act(() => stream.emitLine({ seq: 1, ts: TS, speaker: "Alice", text: "owner hears this", final: true }));
    expect(getByText(`[${TS}] Alice: owner hears this`)).toBeDefined();
    expect(getByRole("button", { name: "Share" })).toBeDefined();
  });

  it("opens the Share modal from the Share button", async () => {
    const { share, getByRole, findByText } = renderOwner();
    fireEvent.click(getByRole("button", { name: "Share" }));
    expect(await findByText("Create share link")).toBeDefined();
    expect(share.requests.some((r) => r.path === "/calls/call_1/share" && r.method === "GET")).toBe(true);
  });

  it("shows Try-again only on COULD_NOT_JOIN and returns to the dashboard with the URL pre-filled", async () => {
    const { stream, redirected, findByRole, queryByRole } = renderOwner();
    expect(queryByRole("button", { name: "Try again" })).toBeNull();
    act(() => stream.emitStatus("COULD_NOT_JOIN"));
    const tryAgain = await findByRole("button", { name: "Try again" });
    fireEvent.click(tryAgain);
    expect(redirected).toEqual([
      `/dashboard?url=${encodeURIComponent(MEETING_URL)}`,
    ]);
  });

  it("shows NO Try-again on ENDED and keeps the finalized transcript", () => {
    const { stream, getByText, queryByRole } = renderOwner();
    act(() => stream.emitLine({ seq: 1, ts: TS, speaker: "Bob", text: "recorded utterance", final: true }));
    act(() => stream.emitStatus("ENDED"));
    expect(queryByRole("button", { name: "Try again" })).toBeNull();
    expect(getByText(`[${TS}] Bob: recorded utterance`)).toBeDefined();
  });

  it("subscribes as the owner session (no share token)", () => {
    const { stream } = renderOwner();
    expect(stream.connects[0]?.auth).toEqual({ kind: "session" });
  });

  // ── Delete a call (SPEC §5.14 GDPR per-call erasure) ────────────────────────
  it("Delete requires confirmation: the first click does NOT hit the endpoint", async () => {
    const { app, getByRole, findByText } = renderOwner();
    fireEvent.click(getByRole("button", { name: "Delete" }));
    // A confirmation prompt appears; no DELETE has been sent yet.
    expect(await findByText(/can.t be undone/i)).toBeDefined();
    expect(app.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("Cancel dismisses the confirmation without deleting", async () => {
    const { app, getByRole, findByRole, queryByText } = renderOwner();
    fireEvent.click(getByRole("button", { name: "Delete" }));
    fireEvent.click(await findByRole("button", { name: "Cancel" }));
    expect(queryByText(/can.t be undone/i)).toBeNull();
    expect(app.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("Confirm delete hits DELETE /calls/:id and returns to the dashboard", async () => {
    const redirected: string[] = [];
    const { app, getByRole, findByRole } = renderOwner({
      redirect: (p) => redirected.push(p),
    });
    fireEvent.click(getByRole("button", { name: "Delete" }));
    const confirm = await findByRole("button", { name: "Confirm delete" });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(
      app.requests.some((r) => r.path === "/calls/call_1" && r.method === "DELETE"),
    ).toBe(true);
    expect(redirected).toEqual(["/dashboard"]);
  });
});
