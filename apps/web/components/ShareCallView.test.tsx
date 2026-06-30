import { describe, it, expect } from "bun:test";
import { render, act } from "@testing-library/react";
import { ShareCallView, SHARE_HEADER_COPY } from "./ShareCallView.tsx";
import {
  SHARE_INACTIVE_COPY,
  RATE_LIMIT_COPY,
} from "./PerCallTranscript.tsx";
import { createFakeTranscriptStreamClient } from "../lib/fakeTranscriptStreamClient.ts";
import type { CallDetail } from "../lib/transcriptStreamClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

const TS = "2026-06-29 10:00:00";

// Default PENDING so the async `fetchCallDetail` seed is a deterministic no-op
// (initial state is already PENDING) — these tests drive status through the
// stream. A non-PENDING seed left un-awaited would schedule a React render task
// that outlives happy-dom's teardown ("window is not defined").
function detail(over: Partial<CallDetail> = {}): CallDetail {
  return { id: "call_1", status: "PENDING", degraded: false, ...over };
}

describe("ShareCallView — read-only shared transcript (SPEC §4.1, §5.7, Stories 2/6)", () => {
  it("renders the read-only header and a Story-6 disclosure note", () => {
    const stream = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByText } = render(
      <ShareCallView streamClient={stream} shareToken="shr_abc" />,
    );
    expect(getByText(SHARE_HEADER_COPY)).toBeDefined();
    expect(getByText(/recording/i)).toBeDefined();
  });

  it("renders live transcript + status from the share-token stream", () => {
    const stream = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { getByText } = render(
      <ShareCallView streamClient={stream} shareToken="shr_abc" />,
    );
    act(() => stream.emitLine({ seq: 1, ts: TS, speaker: "Alice", text: "viewer reads along", final: true }));
    expect(getByText(`[${TS}] Alice: viewer reads along`)).toBeDefined();
  });

  it("connects with the share token and NO session", () => {
    const stream = createFakeTranscriptStreamClient({ callDetail: detail() });
    render(<ShareCallView streamClient={stream} shareToken="shr_abc" />);
    expect(stream.connects[0]?.auth).toEqual({ kind: "share", token: "shr_abc" });
    expect(stream.streamQueries[0]?.token).toBe("shr_abc");
  });

  it("exposes NO owner controls (provably control-free, Story 2)", () => {
    const stream = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { container } = render(
      <ShareCallView streamClient={stream} shareToken="shr_abc" />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows the 'no longer active' card on SAMO-TOKEN-002 (not a silent empty)", async () => {
    const stream = createFakeTranscriptStreamClient({
      failFetchDetailWith: { code: "SAMO-TOKEN-002", message: "gone", status: 410 },
    });
    const { findByText } = render(
      <ShareCallView streamClient={stream} shareToken="shr_abc" />,
    );
    expect(await findByText(SHARE_INACTIVE_COPY)).toBeDefined();
  });

  it("flips to the 'no longer active' card on a mid-stream revoke", async () => {
    const stream = createFakeTranscriptStreamClient({ callDetail: detail() });
    const { findByText } = render(
      <ShareCallView streamClient={stream} shareToken="shr_abc" />,
    );
    act(() => stream.emitClose(4410, "SAMO-TOKEN-002"));
    expect(await findByText(SHARE_INACTIVE_COPY)).toBeDefined();
  });

  it("shows the friendly 429 copy on SAMO-RATE-001", async () => {
    const stream = createFakeTranscriptStreamClient({
      failFetchDetailWith: { code: "SAMO-RATE-001", message: "rate", status: 429 },
    });
    const { findByText } = render(
      <ShareCallView streamClient={stream} shareToken="shr_abc" />,
    );
    expect(await findByText(RATE_LIMIT_COPY)).toBeDefined();
  });
});
