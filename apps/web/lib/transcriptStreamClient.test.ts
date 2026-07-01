/**
 * Coverage for the REAL `createHttpTranscriptStreamClient` (WS + REST seam,
 * SPEC §5.5/§5.7/§5.10). The component/route tests all run against the in-memory
 * `FakeTranscriptStreamClient`; the real transport — the thing the two app pages
 * actually construct — was tested NOWHERE. This closes that gap by stubbing the
 * globals the real client reaches for (`WebSocket` for `connect`, `fetch` for the
 * REST helpers) and asserting exact frame/row/error shapes, not mere existence.
 *
 * Pure Bun (no DOM): a `.test.ts` file, typechecked by the root `tsc --noEmit`.
 * The stubbed globals are installed per-test and torn down in `afterEach`, so
 * nothing leaks into the DOM-registered component tests sharing the process.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppApiError } from "./appApiClient.ts";
import { createHttpTranscriptStreamClient } from "./transcriptStreamClient.ts";
import type { TranscriptStreamEvent } from "./transcriptStreamClient.ts";

const TS = "2026-06-30 10:00:00";

/**
 * Minimal `WebSocket` stand-in: records the `open`/`message`/`close` listeners
 * the client attaches, then lets a test drive the socket as if the server spoke.
 * Only the surface the real client touches (`new`, `addEventListener`, `close`).
 */
class StubWebSocket {
  /** The most recently constructed socket, so a test can drive it. */
  static last: StubWebSocket | null = null;
  readonly url: string;
  closeCalled = false;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    StubWebSocket.last = this;
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closeCalled = true;
  }

  /** Deliver an inbound frame exactly as the server would (`ev.data` is a string). */
  serverMessage(data: string): void {
    this.dispatch("message", { data });
  }

  /** Simulate the server closing the socket with `code`/`reason` (reason "" default). */
  serverClose(code: number, reason = ""): void {
    this.dispatch("close", { code, reason });
  }

  private dispatch(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

/** Per-test fetch handler; the last URL the client requested (asserted on). */
let fetchImpl: (url: string) => Response = () => new Response(null, { status: 500 });
let lastFetchUrl = "";
const stubFetch = (input: unknown): Promise<Response> => {
  lastFetchUrl = String(input);
  return Promise.resolve(fetchImpl(lastFetchUrl));
};

let originalWebSocket: unknown;
let originalFetch: unknown;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  originalFetch = globalThis.fetch;
  Reflect.set(globalThis, "WebSocket", StubWebSocket);
  Reflect.set(globalThis, "fetch", stubFetch);
  StubWebSocket.last = null;
  lastFetchUrl = "";
  fetchImpl = () => new Response(null, { status: 500 });
});

afterEach(() => {
  Reflect.set(globalThis, "WebSocket", originalWebSocket);
  Reflect.set(globalThis, "fetch", originalFetch);
});

const client = createHttpTranscriptStreamClient("https://api.test", "wss://ws.test");
const sessionRef = { callId: "call_1", auth: { kind: "session" } } as const;

describe("createHttpTranscriptStreamClient — connect (WebSocket frames)", () => {
  it("maps an inbound `line` frame through onEvent UNCHANGED", () => {
    const events: TranscriptStreamEvent[] = [];
    client.connect(sessionRef, (e) => events.push(e));
    const ws = StubWebSocket.last;
    expect(ws).not.toBeNull();

    const frame: TranscriptStreamEvent = {
      type: "line",
      seq: 1,
      ts: TS,
      speaker: "Alice",
      text: "hi",
      final: true,
    };
    ws!.serverMessage(JSON.stringify(frame));

    // The parsed JSON is passed straight through — byte-for-byte the same object.
    expect(events).toEqual([frame]);
  });

  it("drops an unparseable/garbage frame without throwing, keeping the stream alive", () => {
    const events: TranscriptStreamEvent[] = [];
    client.connect(sessionRef, (e) => events.push(e));
    const ws = StubWebSocket.last!;

    expect(() => ws.serverMessage("}{ not json at all")).not.toThrow();
    expect(events).toEqual([]);

    // A well-formed frame after the garbage still arrives — the stream survived.
    const frame: TranscriptStreamEvent = {
      type: "line",
      seq: 2,
      ts: TS,
      speaker: "Bob",
      text: "still here",
      final: true,
    };
    ws.serverMessage(JSON.stringify(frame));
    expect(events).toEqual([frame]);
  });

  it("maps a server close(1006) to exactly {type:'closed',code:1006,reason:''}", () => {
    const events: TranscriptStreamEvent[] = [];
    client.connect(sessionRef, (e) => events.push(e));
    const ws = StubWebSocket.last!;

    ws.serverClose(1006);

    expect(events).toEqual([{ type: "closed", code: 1006, reason: "" }]);
  });
});

describe("createHttpTranscriptStreamClient — backfill (REST, malformed filtering)", () => {
  it("returns ONLY the well-formed row, filtering malformed ones", async () => {
    fetchImpl = () =>
      Response.json({
        lines: [
          { seq: 5, ts: TS, speaker: "Bob", text: "kept" }, // valid
          { seq: "x", ts: TS, speaker: "Bob", text: "bad seq type" }, // seq not a number
          { seq: 6, ts: TS, speaker: "Bob" }, // missing text
        ],
      });

    const lines = await client.backfill(sessionRef, 4);

    expect(lines).toEqual([{ seq: 5, ts: TS, speaker: "Bob", text: "kept" }]);
    expect(lastFetchUrl).toBe("https://api.test/calls/call_1/transcript?since_seq=4");
  });
});

describe("createHttpTranscriptStreamClient — fetchCallDetail (REST mapping + typed errors)", () => {
  it("maps ingest_degraded:true → degraded:true", async () => {
    fetchImpl = () => Response.json({ id: "call_1", status: "IN_CALL", ingest_degraded: true });

    const detail = await client.fetchCallDetail(sessionRef);

    expect(detail).toEqual({ id: "call_1", status: "IN_CALL", degraded: true });
  });

  it("throws AppApiError carrying the body's SAMO-AUTHZ-001 code + status 403", async () => {
    fetchImpl = () =>
      Response.json({ code: "SAMO-AUTHZ-001", message: "Forbidden" }, { status: 403 });

    let thrown: unknown;
    try {
      await client.fetchCallDetail(sessionRef);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AppApiError);
    expect((thrown as AppApiError).code).toBe("SAMO-AUTHZ-001");
    expect((thrown as AppApiError).status).toBe(403);
  });
});
