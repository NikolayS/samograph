import { describe, it, expect, mock } from "bun:test";
import { render, act, fireEvent, waitFor } from "@testing-library/react";
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
  over: Partial<{ seq: number; ts: string; speaker: string; text: string; final: boolean; kind: "speech" | "chat" }> = {},
) {
  return { seq: 1, ts: TS, speaker: "Alice", text: "hello world", final: true, ...over };
}

function detail(over: Partial<CallDetail> = {}): CallDetail {
  return { id: "call_1", status: "PENDING", degraded: false, ...over };
}

describe("PerCallTranscript — live read-along (SPEC §2, §5.2, §5.4, §5.5, §5.10)", () => {
  for (const [status, copy] of [
    ["PENDING", "Waiting for the bot to join…"],
    ["JOINING", "Joining the meeting…"],
    ["IN_CALL", "Connected — waiting for the first words."],
  ] as const) {
    it(`renders the exact empty state for ${status}`, async () => {
      const client = createFakeTranscriptStreamClient({
        callDetail: detail({ status }),
      });
      const { findByText } = render(
        <PerCallTranscript
          streamClient={client}
          auth={{ kind: "session" }}
          callId="call_1"
        />,
      );
      expect(await findByText(copy)).toBeDefined();
    });
  }

  it("removes the live empty state when the first line event arrives", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: detail({ status: "IN_CALL" }),
    });
    const { findByText, queryByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    const copy = "Connected — waiting for the first words.";
    expect(await findByText(copy)).toBeDefined();
    act(() => client.emitLine(line({ text: "first words" })));
    expect(queryByText(copy)).toBeNull();
  });

  it("renders a deterministic PENDING header before the stream connects (clean hydration)", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    // initialTranscriptState() is PENDING → the first paint is stable, no effect needed.
    expect(getByText("Starting")).toBeDefined();
  });

  it("keeps the ticking elapsed timer out of the live-region accessibility tree", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    expect(
      container.querySelector(".samograph-status-elapsed")?.getAttribute("aria-hidden"),
    ).toBe("true");
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
    expect(getAllByText(/partial then final/, { selector: ".samograph-visually-hidden" })).toHaveLength(1);
    act(() => client.emitLine(line({ seq: 7, text: "partial then final", final: true })));
    // The partial for seq 7 is cleared as it finalizes — still exactly one rendered line.
    expect(getAllByText(/partial then final/, { selector: ".samograph-visually-hidden" })).toHaveLength(1);
  });

  it("renders finalized lines in the canonical [ts] Speaker: text format", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 1, speaker: "Bob", text: "first" })));
    expect(getByText(`[${TS}] Bob: first`)).toBeDefined();
  });

  it("renders transcript lines with explicit grid column classes", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 3, speaker: "Bob", text: "columns" })));
    const row = container.querySelector(".samograph-transcript-row");
    expect(row).toBeDefined();
    expect(row?.querySelector(".samograph-line-number")?.textContent).toBe("3");
    expect(row?.querySelector(".samograph-line-time")?.textContent).toBe(TS);
    expect(row?.querySelector(".samograph-line-speaker")?.textContent).toContain("Bob");
    expect(row?.querySelector(".samograph-line-utterance")?.textContent).toBe("columns");
  });

  it("splits the timestamp into a droppable date part and a clock part", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ ts: "2026-08-27T18:08:28.000Z", speaker: "Bob" })));
    const time = container.querySelector(".samograph-line-time");
    expect(time?.querySelector(".samograph-line-date")?.textContent).toBe("2026-08-27 ");
    expect(time?.querySelector(".samograph-line-clock")?.textContent).toBe("18:08:28");
    expect(time?.textContent).toBe("2026-08-27 18:08:28");
  });

  it("renders an ISO wire timestamp in canonical UTC form", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container, getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ ts: "2026-08-27T18:08:28.000Z", speaker: "Bob" })));
    expect(container.querySelector(".samograph-line-time")?.textContent).toBe(
      "2026-08-27 18:08:28",
    );
    expect(getByText("[2026-08-27 18:08:28] Bob: hello world")).toBeDefined();
  });

  it("exposes the full speaker label as a tooltip when the visible label is truncated", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ speaker: "Alexander Samokhvalov", kind: "chat" })));
    expect(container.querySelector(".samograph-line-speaker")?.getAttribute("title")).toBe(
      "Alexander Samokhvalov (chat)",
    );
    expect(container.querySelector(".samograph-line-speaker-name")?.textContent).toBe(
      "Alexander Samokhvalov",
    );
    expect(container.querySelector(".samograph-line-speaker-marker")?.textContent).toBe(" (chat):");
  });

  it("keeps the chat marker separate from an ellipsized speaker name on partial lines", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ speaker: "Alexander Samokhvalov", kind: "chat", final: false })));
    const speaker = container.querySelector(".samograph-line-partial .samograph-line-speaker");
    expect(speaker?.getAttribute("title")).toBe("Alexander Samokhvalov (chat)");
    expect(speaker?.querySelector(".samograph-line-speaker-name")?.textContent).toBe(
      "Alexander Samokhvalov",
    );
    expect(speaker?.querySelector(".samograph-line-speaker-marker")?.textContent).toBe(" (chat):");
  });

  it("lets shared viewers hide and show chat without affecting speech or ordinals", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container, getByRole, queryByText } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_abc" }}
        callId="call_1"
      />,
    );
    act(() => client.emitLine(line({ seq: 4, text: "spoken words", kind: "speech" })));
    act(() => client.emitLine(line({ seq: 9, text: "typed words", kind: "chat" })));

    const hideChat = getByRole("button", { name: "Hide chat" });
    expect(hideChat.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".samograph-transcript-actions")?.contains(hideChat)).toBe(true);
    fireEvent.click(hideChat);

    const pressedHideChat = getByRole("button", { name: "Hide chat" });
    expect(pressedHideChat.getAttribute("aria-pressed")).toBe("true");
    expect(queryByText(/typed words/, { selector: ".samograph-visually-hidden" })).toBeNull();
    expect(container.querySelector(".samograph-line-number")?.textContent).toBe("4");
    expect(queryByText(/spoken words/, { selector: ".samograph-visually-hidden" })).toBeDefined();

    fireEvent.click(pressedHideChat);
    expect(getByRole("button", { name: "Hide chat" }).getAttribute("aria-pressed")).toBe("false");
    expect(queryByText(/typed words/, { selector: ".samograph-visually-hidden" })).toBeDefined();
    expect([...container.querySelectorAll(".samograph-line-number")].map((node) => node.textContent)).toEqual(["4", "9"]);
  });

  it("keeps a pinned viewer at the bottom when hidden chat is restored", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container, getByRole } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    const transcript = container.querySelector(".samograph-transcript") as HTMLOListElement;
    const scrollTo = mock(() => undefined);
    transcript.scrollTo = scrollTo;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 480 });

    act(() => client.emitLine(line({ seq: 1, kind: "chat", text: "typed words" })));
    const hideChat = getByRole("button", { name: "Hide chat" });
    fireEvent.click(hideChat);
    scrollTo.mockClear();
    fireEvent.click(hideChat);

    expect(scrollTo).toHaveBeenCalledWith({ top: 480 });
  });

  it("hangs the speaker colour off a data attribute the stylesheet can select", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 1, speaker: "Bob", text: "hue" })));
    act(() => client.emitLine(line({ seq: 2, speaker: "Bob", text: "same hue" })));
    act(() => client.emitLine(line({ seq: 3, speaker: "Alice", text: "other hue" })));
    const indexes = [...container.querySelectorAll(".samograph-line-speaker")].map((el) =>
      el.getAttribute("data-speaker-index"),
    );
    // Stable per speaker, in range, and never smuggled through an inline style
    // (a `[style*=…]` hook depends on CSSOM serialising with a space).
    expect(indexes).toHaveLength(3);
    expect(indexes[0]).toBe(indexes[1]);
    expect(indexes[0]).not.toBe(indexes[2]);
    for (const index of indexes) expect(["0", "1", "2", "3", "4", "5"]).toContain(index);
    expect(container.querySelector(".samograph-line-speaker")?.getAttribute("style")).toBeNull();
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

  it("does not advance the replay cursor past a non-final partial", async () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    render(<PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />);
    act(() => client.emitLine(line({ seq: 5, text: "still partial", final: false })));
    act(() => client.emitClose());
    await waitFor(() => expect(client.connects).toHaveLength(2));
    expect(client.connects[1]?.sinceSeq).toBeUndefined();
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

  it("still surfaces the §5.16 terminal copy when the call already has lines", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { getByText } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 1, text: "said something first" })));
    act(() => client.emitStatus("BOT_REMOVED"));
    // The transcript stays readable, and the failure copy must not vanish with it.
    expect(getByText(/said something first/, { selector: ".samograph-visually-hidden" })).toBeDefined();
    expect(getByText("The bot was removed from the call.")).toBeDefined();
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
    expect(container.querySelector(".samograph-owner-controls")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("button")?.textContent).toBe("Hide chat");
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

  // Story 3 — the downloadable transcript link.
  it("renders a Download-transcript link at /calls/:id/transcript.txt (session)", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByRole } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    const link = getByRole("link", { name: /download transcript/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/calls/call_1/transcript.txt");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("carries the share ?token on the download link in share mode", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByRole } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_abc" }}
        callId="call_9"
      />,
    );
    const link = getByRole("link", { name: /download transcript/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/calls/call_9/transcript.txt?token=shr_abc");
  });

  // #197 — the page offers BOTH the full download and a no-chat download
  // (chat comments filtered out server-side via `?comments=exclude`).
  it("offers BOTH a full download and a no-chat download at the right URLs (session)", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByRole } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    const full = getByRole("link", { name: /download transcript/i }) as HTMLAnchorElement;
    expect(full.getAttribute("href")).toBe("/calls/call_1/transcript.txt");
    expect(full.hasAttribute("download")).toBe(true);
    const speechOnly = getByRole("link", { name: "Download (no chat)" }) as HTMLAnchorElement;
    expect(speechOnly.getAttribute("href")).toBe(
      "/calls/call_1/transcript.txt?comments=exclude",
    );
    expect(speechOnly.hasAttribute("download")).toBe(true);
  });

  it("carries the share ?token on BOTH downloads in share mode", () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByRole } = render(
      <PerCallTranscript
        streamClient={client}
        auth={{ kind: "share", token: "shr_abc" }}
        callId="call_9"
      />,
    );
    const full = getByRole("link", { name: /download transcript/i }) as HTMLAnchorElement;
    expect(full.getAttribute("href")).toBe("/calls/call_9/transcript.txt?token=shr_abc");
    const speechOnly = getByRole("link", { name: "Download (no chat)" }) as HTMLAnchorElement;
    expect(speechOnly.getAttribute("href")).toBe(
      "/calls/call_9/transcript.txt?comments=exclude&token=shr_abc",
    );
  });
});

describe("transcript row markup — reflow follow-ups (#280 review)", () => {
  it("marks the SAMOGRAPH-WARNING <li> as a full-width warning row, not a bare grid cell", async () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() =>
      client.emitLine(
        line({ seq: 1, speaker: "SAMOGRAPH-WARNING", text: "tunnel unreachable (ERR_NGROK_727)" }),
      ),
    );
    await waitFor(() => {
      expect(container.querySelector("li.samograph-warning-row")).not.toBeNull();
    });
    const row = container.querySelector("li.samograph-warning-row") as HTMLLIElement;
    // Exactly this class — NOT the four-column `samograph-transcript-row` grid.
    expect(row.getAttribute("class")).toBe("samograph-warning-row");
    expect(row.querySelector("[role='note']")?.textContent).toBe(
      `[${TS}] SAMOGRAPH-WARNING: tunnel unreachable (ERR_NGROK_727)`,
    );
  });

  it("renders the machine-readable dateTime the TranscriptTime doc comment promises", async () => {
    const client = createFakeTranscriptStreamClient({ callDetail: detail({ status: "IN_CALL" }) });
    const { container } = render(
      <PerCallTranscript streamClient={client} auth={{ kind: "session" }} callId="call_1" />,
    );
    act(() => client.emitLine(line({ seq: 1, ts: TS, text: "hello" })));
    await waitFor(() => {
      expect(container.querySelector("time.samograph-line-time")).not.toBeNull();
    });
    const time = container.querySelector("time.samograph-line-time") as HTMLTimeElement;
    expect(time.getAttribute("dateTime") ?? time.getAttribute("datetime")).toBe(TS);
    expect(time.getAttribute("title")).toBe(TS);
  });
});
