import { describe, it, expect } from "bun:test";
import { createRecallFake, RecallFake } from "./index.ts";
import { RECALL_SIGNATURE_HEADER, recallSignature } from "../../shared/recall/signature.ts";
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

  it("deleteRecording()/leaveCall() are network-free no-ops for GDPR erasure (§5.14)", async () => {
    const fake = createRecallFake({ seed: SEED });
    // The per-call GDPR delete flow (§5.14) asks Recall to erase the recording
    // and force-leaves a still-live bot; against the fake both resolve with no
    // network, no key — the byte-stable fake owns no real recording to delete.
    await expect(fake.deleteRecording(fake.botId)).resolves.toBeUndefined();
    await expect(fake.leaveCall(fake.botId)).resolves.toBeUndefined();
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

describe("Recall fake — signed webhook envelope (SPEC §6.1, §6.2 #7)", () => {
  it("derives a per-fake webhook secret + ingest secret purely from the seed", () => {
    const a = createRecallFake({ seed: SEED });
    const b = createRecallFake({ seed: SEED });
    expect(a.webhookSecret).toBe("whsec_ba241caa");
    expect(a.ingestSecret).toBe("ingsec_07e1c249");
    // Same seed -> identical secrets; different seed -> different secrets.
    expect(b.webhookSecret).toBe(a.webhookSecret);
    expect(b.ingestSecret).toBe(a.ingestSecret);
    expect(createRecallFake({ seed: "alpha" }).webhookSecret).not.toBe(a.webhookSecret);
  });

  it("wraps a lifecycle event in a BYTE-STABLE signed envelope (deterministic id + signature)", () => {
    const env = createRecallFake({ seed: SEED }).webhook(
      createRecallFake({ seed: SEED }).lifecycle("in_call_recording"),
    );

    // Deterministic recall_event_id from (seed, kind, offset) — the idempotency key.
    expect(env.recallEventId).toBe("evt_f019a098");

    // The raw body wraps the inner event with the recall_event_id at the top.
    expect(env.rawBody).toBe(
      '{"recall_event_id":"evt_f019a098","event":"bot.status_change","data":' +
        '{"bot_id":"bot_34d4c316","status":{"code":"in_call_recording","sub_code":null,' +
        '"message":null,"created_at":"2026-01-01T00:00:01.000Z"}}}',
    );

    // ?bot= is the seed bot id; ?t= is the fake's deterministic ingest secret.
    expect(env.url).toBe(
      "https://ingest.local/webhook?bot=bot_34d4c316&t=ingsec_07e1c249",
    );

    // The signature header is HMAC-SHA256 over the EXACT raw body, hex-encoded.
    expect(env.headers[RECALL_SIGNATURE_HEADER]).toBe(
      "f2fdf2aa8f24d04a896b7dcea48741804f007d5544e896a581a5e0b5a5d6f776",
    );

    // Same seed -> byte-identical envelope across two independent constructions.
    const again = createRecallFake({ seed: SEED }).webhook(
      createRecallFake({ seed: SEED }).lifecycle("in_call_recording"),
    );
    expect(again.recallEventId).toBe(env.recallEventId);
    expect(again.rawBody).toBe(env.rawBody);
    expect(again.headers[RECALL_SIGNATURE_HEADER]).toBe(env.headers[RECALL_SIGNATURE_HEADER]);
  });

  it("self-verifies a good envelope and FAILS a tampered body", () => {
    const fake = createRecallFake({ seed: SEED });
    const env = fake.webhook(fake.lifecycle("in_call_recording"));
    expect(fake.verify(env)).toBe(true);

    // Tamper the body without re-signing -> the self-verify must reject it.
    const tamperedBody = { ...env, rawBody: env.rawBody.replace("in_call_recording", "call_ended") };
    expect(fake.verify(tamperedBody)).toBe(false);
  });

  it("mints a bad-signature envelope that fails verify but keeps the body intact", () => {
    const fake = createRecallFake({ seed: SEED });
    const env = fake.webhook(fake.lifecycle("in_call_recording"));
    const bad = fake.badSignature(env);
    expect(bad.rawBody).toBe(env.rawBody); // body untouched
    expect(bad.headers[RECALL_SIGNATURE_HEADER]).not.toBe(env.headers[RECALL_SIGNATURE_HEADER]);
    expect(fake.verify(bad)).toBe(false);
  });

  it("replays an envelope with the SAME recall_event_id (idempotency-key stability)", () => {
    const fake = createRecallFake({ seed: SEED });
    const env = fake.webhook(fake.lifecycle("in_call_recording"));
    const replayed = fake.replay(env);
    expect(replayed.recallEventId).toBe(env.recallEventId);
    expect(replayed.rawBody).toBe(env.rawBody);
    expect(replayed.headers[RECALL_SIGNATURE_HEADER]).toBe(env.headers[RECALL_SIGNATURE_HEADER]);
    expect(fake.verify(replayed)).toBe(true);
  });

  it("honors ?t=/offset/bot overrides and distinct kinds yield distinct event ids", () => {
    const fake = createRecallFake({ seed: SEED });
    const env = fake.webhook(fake.lifecycle("in_call_recording"), {
      ingestSecret: "guessed-wrong",
      offset: 1,
      bot: "bot_attacker",
    });
    expect(env.url).toBe("https://ingest.local/webhook?bot=bot_attacker&t=guessed-wrong");
    // Distinct offset -> distinct recall_event_id (same seed+kind).
    expect(env.recallEventId).toBe("evt_f119a22b");
    // A transcript.data event hashes to a different kind -> a different id.
    const t = fake.webhook(fake.transcriptData({ words: ["hi"], speaker: "Al" }));
    expect(t.recallEventId).toBe("evt_93952b42");
    // Signature still validates over the (overridden) body.
    expect(recallSignature(env.rawBody, fake.webhookSecret)).toBe(env.headers[RECALL_SIGNATURE_HEADER]);
  });
});
