import { describe, it, expect } from "bun:test";
import { render, act, waitFor } from "@testing-library/react";
import {
  PerCallTranscript,
  SHARE_INACTIVE_COPY,
  RATE_LIMIT_COPY,
} from "./PerCallTranscript.tsx";
import { DEGRADED_BANNER_COPY } from "./DegradedBanner.tsx";
import { createFakeTranscriptStreamClient } from "../lib/fakeTranscriptStreamClient.ts";
import type { CallDetail } from "../lib/transcriptStreamClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

const TS = "2026-06-29 10:00:00";

function line(
  over: Partial<{ seq: number; ts: string; speaker: string; text: string; final: boolean }> = {},
) {
  return { seq: 1, ts: TS, speaker: "Alice", text: "hello world", final: true, ...over };
}

function detail(over: Partial<CallDetail> = {}): CallDetail {
  return { id: "call_1", status: "PENDING", degraded: false, ...over };
}

describe("PerCallTranscript — live read-along (SPEC §2, §5.2, §5.4, §5.5, §5.10)", () => {
  it("renders a deterministic PENDING header before the stream connects (clean hydration)", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    // initialTranscriptState() is PENDING → the first paint is stable, no effect needed.
    expect(getByText("Starting")).toBeDefined();
  });

  it("updates the status header as the stream reports JOINING → IN_CALL", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitStatus("JOINING"));
    expect(getByText("Joining")).toBeDefined();
    act(() => client.emitStatus("IN_CALL"));
    expect(getByText("Live")).toBeDefined();
  });

  it("seeds the header from fetchCallDetail on mount", async () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { findByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    expect(await findByText("Live")).toBeDefined();
    // The detail was fetched through the seam, not assumed.
    expect(client.requests.some((r) => r.path === "/calls/call_1")).toBe(true);
  });

  it("subscribes with the caller's auth + callId", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    render(<PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />);
    expect(client.connects).toHaveLength(1);
    expect(client.connects[0]?.callId).toBe("call_1");
    expect(client.connects[0]?.auth).toEqual({ kind: "session" });
    expect(client.connects[0]?.sinceSeq).toBeUndefined();
  });

  it("shows a partial line, then replaces it with exactly one finalized line (no dupe)", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { getAllByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 7, text: "partial then final", final: false })));
    expect(getAllByText(/partial then final/)).toHaveLength(1);
    act(() => client.emitLine(line({ seq: 7, text: "partial then final", final: true })));
    // The partial for seq 7 is cleared as it finalizes — still exactly one rendered line.
    expect(getAllByText(/partial then final/)).toHaveLength(1);
  });

  it("renders finalized lines in the canonical [ts] Speaker: text format", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 1, speaker: "Bob", text: "first" })));
    expect(getByText(`[${TS}] Bob: first`)).toBeDefined();
  });

  it("shows the degraded banner on emitDegraded(true) and clears it on recovery", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { getByText, queryByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitDegraded(true));
    expect(getByText(DEGRADED_BANNER_COPY)).toBeDefined();
    // A `tunnel recovered` warning line + the overlay flag both clear the banner.
    act(() =>
      client.emitLine(
        line({ seq: 2, speaker: "SAMOGRAPH-WARNING", text: "tunnel recovered", final: true }),
      ),
    );
    act(() => client.emitDegraded(false));
    expect(queryByText(DEGRADED_BANNER_COPY)).toBeNull();
  });

  it("backfills in order after a gap control frame", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "IN_CALL" }),
      backfillLines: [
        { seq: 2, ts: TS, speaker: "Bob", text: "gap-two" },
        { seq: 3, ts: TS, speaker: "Bob", text: "gap-three" },
      ],
    });
    const { getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 1, text: "gap-one" })));
    act(() => client.emitGap(1, 3));
    await waitFor(() => expect(getByText(`[${TS}] Bob: gap-three`)).toBeDefined());
    // The backfill REST endpoint was actually hit for the missing range.
    expect(client.requests.some((r) => r.path === "/calls/call_1/transcript")).toBe(true);
  });

  it("reconnects after a close with sinceSeq = last seen seq", async () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    render(<PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />);
    act(() => client.emitLine(line({ seq: 5, text: "before drop" })));
    act(() => client.emitClose());
    await waitFor(() => expect(client.connects).toHaveLength(2));
    expect(client.connects[1]?.sinceSeq).toBe(5);
  });

  it("renders the §5.16 terminal copy on COULD_NOT_JOIN, closes the stream, but keeps controls", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { getByText, queryByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "session" }}
        callId="call_1"
        recallReason="the meeting hasn't started"
        controls={() => <button type="button">owner-control</button>}
      />,
    );
    act(() => client.emitStatus("COULD_NOT_JOIN"));
    expect(getByText("Couldn't join — the meeting hasn't started.")).toBeDefined();
    // Controls still render in a terminal state (Try-again lives here).
    expect(getByText("owner-control")).toBeDefined();
    // The stream is closed: a late line is NOT delivered.
    act(() => client.emitLine(line({ seq: 9, text: "after terminal" })));
    expect(queryByText(/after terminal/)).toBeNull();
  });

  it("renders NO owner controls when the controls slot is omitted", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { container } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_x" }}
        callId="call_1"
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("surfaces a typed SAMO-TOKEN-002 from fetchCallDetail as a 'no longer active' card", async () => {
    const client = createFakeTranscriptStreamClient({
      failFetchDetailWith: { code: "SAMO-TOKEN-002", message: "raw server msg", status: 410 },
    });
    const { findByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_x" }}
        callId="call_1"
      />,
    );
    expect(await findByText(SHARE_INACTIVE_COPY)).toBeDefined();
  });

  it("surfaces a mid-stream SAMO-TOKEN-002 close as the 'no longer active' card (no reconnect)", async () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { findByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_x" }}
        callId="call_1"
      />,
    );
    act(() => client.emitClose(4410, "SAMO-TOKEN-002"));
    expect(await findByText(SHARE_INACTIVE_COPY)).toBeDefined();
    // A fatal close does NOT trigger a reconnect.
    await new Promise((r) => setTimeout(r, 0));
    expect(client.connects).toHaveLength(1);
  });

  it("surfaces SAMO-RATE-001 as the friendly 429 copy", async () => {
    const client = createFakeTranscriptStreamClient({
      failFetchDetailWith: { code: "SAMO-RATE-001", message: "raw", status: 429 },
    });
    const { findByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_x" }}
        callId="call_1"
      />,
    );
    expect(await findByText(RATE_LIMIT_COPY)).toBeDefined();
  });
});

describe("PerCallTranscript — status poll fallback (#106: cross-process status liveness)", () => {
  // The app-api status poller publishes status flips via pg_notify, but no
  // process runs LISTEN (Bun SQL has none), so on a real call NO WS `status`
  // frame ever reaches an open page. The page must still go live: while the
  // status is non-terminal it re-polls GET /calls/:id and reflects the change.

  it("reflects a status change via polling with NO WS status frame", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "JOINING" }),
    });
    const { findByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "session" }}
        callId="call_1"
        statusPollIntervalMs={10}
      />,
    );
    expect(await findByText("Joining")).toBeDefined();
    // The status flips server-side; the WS hub (fed only in-process) says nothing.
    client.setCallDetail(detail({ status: "IN_CALL" }));
    expect(await findByText("Live")).toBeDefined();
    // …and again to a terminal state, still with no WS frame.
    client.setCallDetail(detail({ status: "ENDED" }));
    expect(await findByText("Ended")).toBeDefined();
    // The change arrived through repeated GET /calls/:id polls, not the mount fetch.
    expect(client.requests.filter((r) => r.path === "/calls/call_1").length).toBeGreaterThan(2);
  });

  it("stops polling once the status is terminal and closes the stream", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "IN_CALL" }),
    });
    const { findByText, queryByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "session" }}
        callId="call_1"
        statusPollIntervalMs={10}
      />,
    );
    client.setCallDetail(detail({ status: "ENDED" }));
    expect(await findByText("Ended")).toBeDefined();
    // Polling stops: the request count settles and stays settled.
    await new Promise((r) => setTimeout(r, 30));
    const settled = client.requests.filter((r) => r.path === "/calls/call_1").length;
    await new Promise((r) => setTimeout(r, 50));
    expect(client.requests.filter((r) => r.path === "/calls/call_1").length).toBe(settled);
    // The stream was torn down too: a late line is NOT delivered.
    act(() => client.emitLine(line({ seq: 9, text: "after poll-terminal" })));
    expect(queryByText(/after poll-terminal/)).toBeNull();
  });

  it("the terminal poll result carries the §5.16 statusReason into the header", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "JOINING" }),
    });
    const { findByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "session" }}
        callId="call_1"
        statusPollIntervalMs={10}
      />,
    );
    expect(await findByText("Joining")).toBeDefined();
    client.setCallDetail(
      detail({ status: "COULD_NOT_JOIN", statusReason: "meeting_not_found" }),
    );
    expect(await findByText("Couldn't join — meeting_not_found.")).toBeDefined();
  });

  it("share mode: every status poll carries the share token (§5.7)", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "IN_CALL" }),
    });
    render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_x" }}
        callId="call_1"
        statusPollIntervalMs={10}
      />,
    );
    await waitFor(() => {
      const polls = client.requests.filter((r) => r.path === "/calls/call_1");
      expect(polls.length).toBeGreaterThan(2);
    });
    for (const r of client.requests.filter((r) => r.path === "/calls/call_1")) {
      expect(r.query).toEqual({ token: "shr_x" });
    }
  });

  it("a WS-delivered terminal status also stops the poll (single-process path)", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "IN_CALL" }),
    });
    const { getByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "session" }}
        callId="call_1"
        statusPollIntervalMs={10}
      />,
    );
    act(() => client.emitStatus("ENDED"));
    expect(getByText("Ended")).toBeDefined();
    await new Promise((r) => setTimeout(r, 30));
    const settled = client.requests.filter((r) => r.path === "/calls/call_1").length;
    await new Promise((r) => setTimeout(r, 50));
    expect(client.requests.filter((r) => r.path === "/calls/call_1").length).toBe(settled);
  });
});

describe("PerCallTranscript — failed calls display the persisted error reason (SPEC §5.16)", () => {
  it("COULD_NOT_JOIN: the header message carries the statusReason from /calls/:id", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "COULD_NOT_JOIN", statusReason: "meeting_not_found" }),
    });
    const { findByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    expect(await findByText("Couldn't join — meeting_not_found.")).toBeDefined();
    expect(await findByText("SAMO-CALL-JOIN")).toBeDefined();
  });

  it("COULD_NOT_RECORD: the header message carries the statusReason", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({
        status: "COULD_NOT_RECORD",
        statusReason: "recording_permission_denied_by_host",
      }),
    });
    const { findByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    expect(
      await findByText("Couldn't start recording — recording_permission_denied_by_host."),
    ).toBeDefined();
    expect(await findByText("SAMO-CALL-NOREC")).toBeDefined();
  });

  it("an explicit recallReason prop still wins over the fetched detail", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "COULD_NOT_JOIN", statusReason: "meeting_not_found" }),
    });
    const { findByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "session" }}
        callId="call_1"
        recallReason="denied entry"
      />,
    );
    expect(await findByText("Couldn't join — denied entry.")).toBeDefined();
  });

  it("the reason survives a stream status frame arriving before the detail settles", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "COULD_NOT_JOIN", statusReason: "meeting_not_found" }),
      holdDetail: true,
    });
    const { findByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    // The stream speaks FIRST (terminal status, no reason on the frame)…
    act(() => client.emitStatus("COULD_NOT_JOIN"));
    expect(await findByText("Couldn't join — the meeting couldn't be reached.")).toBeDefined();
    // …then the REST detail lands: the persisted reason still reaches the header.
    await act(async () => client.releaseDetail());
    expect(await findByText("Couldn't join — meeting_not_found.")).toBeDefined();
  });
});
