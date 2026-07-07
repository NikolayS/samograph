import { describe, it, expect } from "bun:test";
import { AppApiError } from "./appApiClient.ts";
import { createFakeTranscriptStreamClient } from "./fakeTranscriptStreamClient.ts";
import type { TranscriptStreamEvent } from "./transcriptStreamClient.ts";

const TS = "2026-01-01 00:01:30";

describe("FakeTranscriptStreamClient — connect arg recording (SPEC §5.5/§5.7)", () => {
  it("records since_seq on the wire query", () => {
    const client = createFakeTranscriptStreamClient();
    client.connect({ callId: "call_1", auth: { kind: "session" }, sinceSeq: 42 }, () => {});
    expect(client.connects[0]).toEqual({
      callId: "call_1",
      auth: { kind: "session" },
      sinceSeq: 42,
    });
    expect(client.streamQueries[0]).toEqual({ since_seq: "42" });
  });

  it("a share connect records the token; a session connect does not", () => {
    const client = createFakeTranscriptStreamClient();
    client.connect({ callId: "c", auth: { kind: "share", token: "shr_abc" } }, () => {});
    client.connect({ callId: "c", auth: { kind: "session" } }, () => {});
    expect(client.streamQueries[0]).toEqual({ token: "shr_abc" });
    expect(client.streamQueries[1]).toEqual({});
  });
});

describe("FakeTranscriptStreamClient — scripted delivery", () => {
  it("emitters deliver frames in order to every open subscriber", () => {
    const client = createFakeTranscriptStreamClient();
    const a: TranscriptStreamEvent[] = [];
    const b: TranscriptStreamEvent[] = [];
    client.connect({ callId: "c", auth: { kind: "session" } }, (e) => a.push(e));
    client.connect({ callId: "c", auth: { kind: "share", token: "t" } }, (e) => b.push(e));

    client.emitStatus("IN_CALL");
    client.emitLine({ seq: 1, ts: TS, speaker: "Alice", text: "hi", final: true });
    client.emitGap(2, 4);
    client.emitDegraded(true);

    const expected: TranscriptStreamEvent[] = [
      { type: "status", status: "IN_CALL" },
      { type: "line", seq: 1, ts: TS, speaker: "Alice", text: "hi", final: true },
      { type: "gap", sinceSeq: 2, untilSeq: 4 },
      { type: "degraded", degraded: true },
    ];
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
  });

  it("close() stops further delivery to that subscriber", () => {
    const client = createFakeTranscriptStreamClient();
    const got: TranscriptStreamEvent[] = [];
    const handle = client.connect({ callId: "c", auth: { kind: "session" } }, (e) => got.push(e));
    client.emitStatus("IN_CALL");
    handle.close();
    client.emitStatus("ENDED");
    expect(got).toEqual([{ type: "status", status: "IN_CALL" }]);
  });

  it("emitClose delivers a closed frame with code + reason", () => {
    const client = createFakeTranscriptStreamClient();
    const got: TranscriptStreamEvent[] = [];
    client.connect({ callId: "c", auth: { kind: "session" } }, (e) => got.push(e));
    client.emitClose(1006, "abnormal");
    expect(got).toEqual([{ type: "closed", code: 1006, reason: "abnormal" }]);
  });
});

describe("FakeTranscriptStreamClient — seeded REST helpers + typed throws", () => {
  it("returns the seeded fetchCallDetail and records the request", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: { id: "call_1", status: "IN_CALL", degraded: true },
    });
    const detail = await client.fetchCallDetail({ callId: "call_1", auth: { kind: "session" } });
    expect(detail).toEqual({ id: "call_1", status: "IN_CALL", degraded: true });
    expect(client.requests).toContainEqual({
      path: "/calls/call_1",
      method: "GET",
      callId: "call_1",
      query: {},
    });
  });

  it("records the share token on a REST request's wire query (§5.7)", async () => {
    const client = createFakeTranscriptStreamClient();
    await client.fetchCallDetail({ callId: "call_1", auth: { kind: "share", token: "shr_abc" } });
    expect(client.requests[0]?.query).toEqual({ token: "shr_abc" });
  });

  it("setCallDetail changes what fetchCallDetail serves from then on", async () => {
    const client = createFakeTranscriptStreamClient({
      callDetail: { id: "call_1", status: "JOINING", degraded: false },
    });
    const ref = { callId: "call_1", auth: { kind: "session" } } as const;
    expect((await client.fetchCallDetail(ref)).status).toBe("JOINING");
    client.setCallDetail({ id: "call_1", status: "ENDED", degraded: false });
    expect((await client.fetchCallDetail(ref)).status).toBe("ENDED");
  });

  it("returns the seeded backfill lines for the requested range", async () => {
    const client = createFakeTranscriptStreamClient({
      backfillLines: [
        { seq: 2, ts: TS, speaker: "Bob", text: "two" },
        { seq: 3, ts: TS, speaker: "Bob", text: "three" },
      ],
    });
    const lines = await client.backfill({ callId: "call_1", auth: { kind: "session" } }, 1);
    expect(lines.map((l) => l.seq)).toEqual([2, 3]);
  });

  it("a configured failure throws AppApiError carrying SAMO-TOKEN-002", async () => {
    const client = createFakeTranscriptStreamClient({
      failBackfillWith: { code: "SAMO-TOKEN-002", message: "no longer active", status: 410 },
    });
    let thrown: unknown;
    try {
      await client.backfill({ callId: "c", auth: { kind: "share", token: "t" } }, 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-TOKEN-002");
  });

  it("a configured failure honors `retryable` (SAMO-RATE-001)", async () => {
    const client = createFakeTranscriptStreamClient({
      failFetchDetailWith: { code: "SAMO-RATE-001", message: "slow down", retryable: true, status: 429 },
    });
    let thrown: unknown;
    try {
      await client.fetchCallDetail({ callId: "c", auth: { kind: "share", token: "t" } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-RATE-001");
    expect((thrown as AppApiError).retryable).toBe(true);
  });
});
