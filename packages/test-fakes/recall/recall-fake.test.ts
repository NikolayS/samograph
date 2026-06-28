import { describe, it, expect } from "bun:test";
import { createRecallFake, RecallFake } from "./index.ts";
// The fake must produce payloads the real CLI transcript formatter consumes,
// proving shape-compatibility with src/transcript.ts (the §6.1 PR-gate Recall).
import { formatTranscriptLine } from "../../../src/transcript.ts";

const SEED = "acceptance-seed-001";

describe("Recall fake — deterministic, seedable, network-free (SPEC §6.1)", () => {
  it("createBot() returns a stable bot_id derived purely from the seed", () => {
    const a = createRecallFake({ seed: SEED });
    const b = createRecallFake({ seed: SEED });
    expect(a.botId).toBe("bot_34d4c316");
    expect(a.createBot()).toEqual({ id: "bot_34d4c316" });
    // Same seed -> identical id; createBot is idempotent.
    expect(b.botId).toBe(a.botId);
    expect(b.createBot()).toEqual(a.createBot());
    // Different seed -> different deterministic id.
    expect(createRecallFake({ seed: "alpha" }).botId).toBe("bot_5d8b6dab");
  });

  it("emits a BYTE-STABLE in_call_recording event for a given seed (§6.2 #8 acceptance)", () => {
    const fake = createRecallFake({ seed: SEED });
    const event = fake.lifecycle("in_call_recording");

    // Exact-value (deep) assertion — not mere existence.
    expect(event).toEqual({
      event: "bot.status_change",
      data: {
        bot_id: "bot_34d4c316",
        status: {
          code: "in_call_recording",
          sub_code: null,
          message: null,
          created_at: "2026-01-01T00:00:01.000Z",
        },
      },
    });

    // Byte-stable serialization (stable key order, no clock dependence).
    expect(JSON.stringify(event)).toBe(
      '{"event":"bot.status_change","data":{"bot_id":"bot_34d4c316","status":' +
        '{"code":"in_call_recording","sub_code":null,"message":null,' +
        '"created_at":"2026-01-01T00:00:01.000Z"}}}',
    );

    // Determinism: re-deriving the same event from a fresh fake is identical.
    expect(createRecallFake({ seed: SEED }).lifecycle("in_call_recording")).toEqual(
      event,
    );
  });

  it("synthesizes every lifecycle code with stable, distinct created_at", () => {
    const fake = createRecallFake({ seed: SEED });
    const code = (c: Parameters<RecallFake["lifecycle"]>[0]) =>
      fake.lifecycle(c).data.status;

    expect(code("fatal")).toEqual({
      code: "fatal",
      sub_code: "meeting_not_found",
      message: null,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(code("in_call_recording").created_at).toBe("2026-01-01T00:00:01.000Z");
    expect(code("in_call_not_recording").created_at).toBe(
      "2026-01-01T00:00:02.000Z",
    );
    expect(code("call_ended").created_at).toBe("2026-01-01T00:00:03.000Z");
    expect(code("bot_removed").created_at).toBe("2026-01-01T00:00:04.000Z");

    // fatal reason is overridable (the Recall reason string surfaced in §6.2 #8).
    expect(fake.lifecycle("fatal", { reason: "bot_kicked_from_call" }).data.status.sub_code).toBe(
      "bot_kicked_from_call",
    );
  });

  it("produces transcript.data payloads the CLI formatter consumes (shape parity)", () => {
    const fake = createRecallFake({ seed: SEED });
    const payload = fake.transcriptData({
      speaker: "Alice",
      words: ["hello", "world"],
      at: "2026-01-01T00:01:30.000Z",
    });

    expect(payload).toEqual({
      event: "transcript.data",
      data: {
        data: {
          participant: { name: "Alice" },
          words: [
            { text: "hello", start_timestamp: { absolute: "2026-01-01T00:01:30.000Z" } },
            { text: "world", start_timestamp: { absolute: "2026-01-01T00:01:30.000Z" } },
          ],
        },
      },
    });

    // The real CLI formatter turns the fake payload into an exact transcript line.
    expect(formatTranscriptLine(payload)).toBe("[2026-01-01 00:01:30] Alice: hello world");
  });
});
