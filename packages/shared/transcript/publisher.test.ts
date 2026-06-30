/**
 * `TranscriptPublisher` port — pure tests for the in-memory fake + the
 * per-call channel keying (SPEC §5.5 "one pub/sub channel per call_id", §5.11).
 *
 * The fake is what ingest's transcript pipeline (#78), the watchdog (#81) and
 * lifecycle (#79) publish onto, and what ws-hub (#83) consumes — so these tests
 * pin the seam contract with NO Postgres, NO ws-hub, NO tokens.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import {
  InMemoryTranscriptPublisher,
  PgListenNotifyPublisher,
  createInMemoryTranscriptPublisher,
  encodeSignal,
  parseSignal,
  transcriptChannel,
  type TranscriptControlFrame,
  type TranscriptLineFrame,
} from "./publisher.ts";

const lineFrame = (call_id: string, seq: number): TranscriptLineFrame => ({
  type: "line",
  call_id,
  seq,
  ts: "2026-01-01 00:01:30",
  speaker: "Alice",
  text: `line ${seq}`,
});

describe("TranscriptPublisher in-memory fake (§5.5)", () => {
  it("records every published frame in publish order", () => {
    const pub = createInMemoryTranscriptPublisher();
    pub.publish(lineFrame("call-A", 1));
    pub.publish(lineFrame("call-A", 2));

    expect(pub.published).toEqual([lineFrame("call-A", 1), lineFrame("call-A", 2)]);
  });

  it("publishes a line frame as exactly {type,call_id,seq,ts,speaker,text}", () => {
    const pub = new InMemoryTranscriptPublisher();
    pub.publish(lineFrame("call-A", 7));
    expect(pub.published[0]).toEqual({
      type: "line",
      call_id: "call-A",
      seq: 7,
      ts: "2026-01-01 00:01:30",
      speaker: "Alice",
      text: "line 7",
    });
  });

  it("keys frames per call_id — a subscriber on call B never sees call A's lines (§5.5 isolation)", () => {
    const pub = new InMemoryTranscriptPublisher();
    pub.publish(lineFrame("call-A", 1));
    pub.publish(lineFrame("call-B", 1));
    pub.publish(lineFrame("call-A", 2));

    expect(pub.linesFor("call-A").map((f) => f.seq)).toEqual([1, 2]);
    expect(pub.linesFor("call-B").map((f) => f.seq)).toEqual([1]);
    // Strict isolation: nothing from A leaks into B's channel and vice-versa.
    expect(pub.framesFor("call-B").every((f) => f.call_id === "call-B")).toBe(true);
    expect(pub.framesFor("call-A").every((f) => f.call_id === "call-A")).toBe(true);
  });

  it("carries control frames (tunnel warning / status) on the same per-call channel", () => {
    const pub = new InMemoryTranscriptPublisher();
    const warning: TranscriptControlFrame = {
      type: "warning",
      call_id: "call-A",
      text: "tunnel unreachable (ERR_NGROK_727)",
    };
    pub.publish(lineFrame("call-A", 1));
    pub.publish(warning);

    expect(pub.framesFor("call-A")).toEqual([lineFrame("call-A", 1), warning]);
    // Control frames are not lines.
    expect(pub.linesFor("call-A").map((f) => f.seq)).toEqual([1]);
  });
});

describe("encodeSignal / parseSignal — the 8 KB-safe NOTIFY payload (#98)", () => {
  it("reduces a line frame to a tiny { k:'line', call_id, seq } signal (no text)", () => {
    const frame = lineFrame("call-A", 42);
    const sig = encodeSignal(frame);
    expect(sig).toEqual({ k: "line", call_id: "call-A", seq: 42 });
    // The signal is constant-size regardless of utterance length — the #98 fix.
    const huge = { ...frame, text: "x".repeat(20_000) };
    expect(JSON.stringify(encodeSignal(huge))).toBe(JSON.stringify(sig));
    expect(JSON.stringify(encodeSignal(huge)).length).toBeLessThan(120);
  });

  it("carries a (small, seq-less) control frame inline as { k:'ctl', frame }", () => {
    const warning: TranscriptControlFrame = { type: "warning", call_id: "call-A", text: "tunnel unreachable" };
    expect(encodeSignal(warning)).toEqual({ k: "ctl", frame: warning });
  });

  it("round-trips a line and a control signal through parse", () => {
    const line = encodeSignal(lineFrame("c1", 9));
    expect(parseSignal(JSON.stringify(line))).toEqual(line);
    const ctl = encodeSignal({ type: "status", call_id: "c1", status: "IN_CALL" });
    expect(parseSignal(JSON.stringify(ctl))).toEqual(ctl);
  });

  it("rejects malformed / non-signal payloads as null", () => {
    for (const bad of ["", "not json", "null", "[]", '{"k":"line"}', '{"k":"line","call_id":"c"}', '{"k":"ctl"}', '{"k":"nope"}']) {
      expect(parseSignal(bad)).toBeNull();
    }
  });
});

// ─── DB-gated: the actual 8 KB pg_notify cap, against real Postgres (#98) ──────
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("PgListenNotifyPublisher — long utterance can't roll back the dedup tx (#98)", () => {
  let sql: ReturnType<typeof connect>;
  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });
  afterAll(async () => {
    await sql`DELETE FROM webhook_events WHERE bot_id LIKE 'wh-8kb-%'`;
    await sql.close();
  });

  it("a >8 KB line published INSIDE a tx does not throw, and the tx commits", async () => {
    const pub = new PgListenNotifyPublisher(sql);
    const botId = `wh-8kb-${randomUUID()}`;
    const eventId = `evt-${randomUUID()}`;
    const callId = randomUUID();
    // 9000-byte utterance > the hard 8000-byte pg_notify payload cap. The OLD
    // impl put the full frame JSON in the payload → 'payload string too long'
    // thrown INSIDE the tx → the wrapping dedup tx (the marker insert) rolls back.
    const frame: TranscriptLineFrame = {
      type: "line", call_id: callId, seq: 7, ts: "2026-01-01 00:00:00", speaker: "Alice", text: "x".repeat(9000),
    };

    await sql.begin(async (tx) => {
      // Stand in for the §93 dedup-ledger write that wraps publish.
      await tx`INSERT INTO webhook_events (bot_id, recall_event_id) VALUES (${botId}, ${eventId})`;
      await pub.publish(frame, tx); // GREEN: signal-only payload, never overflows
    });

    // The wrapping tx COMMITTED — the marker row survived (proves no rollback).
    const rows = await sql`SELECT 1 AS ok FROM webhook_events WHERE bot_id = ${botId} AND recall_event_id = ${eventId}`;
    expect(rows.length).toBe(1);
  });
});

describe("transcriptChannel — one LISTEN/NOTIFY channel per call_id (§5.5)", () => {
  it("derives a distinct, ≤63-byte channel per call_id", () => {
    const callId = "11111111-1111-1111-1111-111111111111";
    expect(transcriptChannel(callId)).toBe(`transcript:${callId}`);
    // Postgres channel names cap at NAMEDATALEN-1 (63 bytes).
    expect(transcriptChannel(callId).length).toBeLessThanOrEqual(63);
    expect(transcriptChannel("call-A")).not.toBe(transcriptChannel("call-B"));
  });
});
