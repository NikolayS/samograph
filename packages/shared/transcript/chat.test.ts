/**
 * Incoming meeting-chat normalization tests (#188).
 *
 * Recall delivers received chat via the realtime event
 * `participant_events.chat_message`. These pure tests pin the exact framing of
 * the new {@link normalizeTranscriptEvent} model entry point, which carries a
 * `kind` (`speech` | `chat`) and renders a chat line with the ` (chat)` marker
 * right after the sender name. The legacy {@link normalizeTranscriptLine} stays
 * speech-only so the hosted ingest path that reuses it is unaffected.
 */
import { describe, it, expect } from "bun:test";
import {
  normalizeTranscriptEvent,
  normalizeTranscriptLine,
  type NormalizedTranscriptLine,
} from "./index.ts";
// The deterministic, network-free in-repo Recall fake (SPEC §6.1) is the
// source of realistic chat payload shapes.
import { createRecallFake } from "../../test-fakes/recall/index.ts";

const SEED = "chat-seed-001";
const AT = "2026-01-01T00:01:30.000Z"; // matches the fake's deterministic default

/** Hand-build a `participant_events.chat_message` payload with full control. */
function chatEvent(opts: {
  name?: string | null; // null => omit `participant` entirely
  text?: string;
  to?: string;
  isHost?: boolean;
  at?: string;
  event?: string;
}): unknown {
  const inner: Record<string, unknown> = {};
  if (opts.name !== null && opts.name !== undefined) {
    inner.participant = { name: opts.name, is_host: opts.isHost ?? false, email: null };
  }
  inner.timestamp = { absolute: opts.at ?? AT, relative: 90 };
  inner.data = { text: opts.text ?? "", to: opts.to ?? "everyone" };
  return { event: opts.event ?? "participant_events.chat_message", data: { data: inner } };
}

/** Hand-build a `transcript.data` (spoken) payload. */
function speechEvent(speaker: string, words: string[], at = AT): unknown {
  return {
    event: "transcript.data",
    data: {
      data: {
        participant: { name: speaker },
        words: words.map((text) => ({ text, start_timestamp: { absolute: at } })),
      },
    },
  };
}

describe("normalizeTranscriptEvent — kind + chat marker (#188)", () => {
  it("a chat message → kind=chat and the ` (chat)` marker after the name", () => {
    const ev: NormalizedTranscriptLine | null = normalizeTranscriptEvent(
      chatEvent({ name: "Alice", text: "hello everyone", at: AT }),
    );
    expect(ev).toEqual({
      kind: "chat",
      line: "[2026-01-01 00:01:30] Alice (chat): hello everyone",
    });
  });

  it("a spoken line → kind=speech with NO marker", () => {
    const ev = normalizeTranscriptEvent(speechEvent("Bob", ["hi", "there"], AT));
    expect(ev).toEqual({ kind: "speech", line: "[2026-01-01 00:01:30] Bob: hi there" });
    expect(ev!.line).not.toContain("(chat)");
  });

  it("chat framing matches the CLI apart from the marker (ms dropped, 19-char ts)", () => {
    expect(
      normalizeTranscriptEvent(chatEvent({ name: "Eve", text: "x", at: "2025-12-31T23:59:59.999999Z" })),
    ).toEqual({ kind: "chat", line: "[2025-12-31 23:59:59] Eve (chat): x" });
  });

  it("missing / blank chat sender → '?' (marker still present)", () => {
    expect(
      normalizeTranscriptEvent(chatEvent({ name: null, text: "hi", at: "2026-01-01T00:00:00.000Z" })),
    ).toEqual({ kind: "chat", line: "[2026-01-01 00:00:00] ? (chat): hi" });
    expect(
      normalizeTranscriptEvent(chatEvent({ name: "   ", text: "hi", at: "2026-01-01T00:00:00.000Z" })),
    ).toEqual({ kind: "chat", line: "[2026-01-01 00:00:00] ? (chat): hi" });
  });

  it("collapses CR/LF + internal whitespace in the sender and text (one physical line)", () => {
    expect(
      normalizeTranscriptEvent(chatEvent({ name: "  Al\tEx  ", text: " see\r\nthis ", at: AT })),
    ).toEqual({ kind: "chat", line: "[2026-01-01 00:01:30] Al Ex (chat): see this" });
  });

  it("Unicode chat text and sender preserved verbatim", () => {
    expect(
      normalizeTranscriptEvent(chatEvent({ name: "Renée", text: "café ☕ 日本語 🙂", at: AT })),
    ).toEqual({ kind: "chat", line: "[2026-01-01 00:01:30] Renée (chat): café ☕ 日本語 🙂" });
  });

  it("empty / whitespace-only chat text → null (nothing to show, never throws)", () => {
    expect(normalizeTranscriptEvent(chatEvent({ name: "Alice", text: "" }))).toBeNull();
    expect(normalizeTranscriptEvent(chatEvent({ name: "Alice", text: "   " }))).toBeNull();
  });

  it("malformed / other events → null (never throws)", () => {
    expect(
      normalizeTranscriptEvent(chatEvent({ name: "Alice", text: "hi", event: "other.event" })),
    ).toBeNull();
    expect(normalizeTranscriptEvent(null)).toBeNull();
    expect(normalizeTranscriptEvent(undefined)).toBeNull();
    expect(normalizeTranscriptEvent("nope")).toBeNull();
    expect(normalizeTranscriptEvent(42)).toBeNull();
    expect(normalizeTranscriptEvent({})).toBeNull();
  });

  it("drives the in-repo Recall fake's chatMessage() to an exact line", () => {
    const fake = createRecallFake({ seed: SEED });
    const ev = normalizeTranscriptEvent(
      fake.chatMessage({ speaker: "Alice", text: "hi from chat", at: AT }),
    );
    expect(ev).toEqual({ kind: "chat", line: "[2026-01-01 00:01:30] Alice (chat): hi from chat" });
  });

  it("legacy normalizeTranscriptLine stays speech-only — chat is IGNORED there (#188)", () => {
    // The hosted ingest path REUSES normalizeTranscriptLine and must NOT start
    // persisting chat. Only normalizeTranscriptEvent surfaces chat lines.
    expect(normalizeTranscriptLine(chatEvent({ name: "Alice", text: "hi", at: AT }))).toBeNull();
    // speech still flows through the legacy entry point unchanged
    expect(normalizeTranscriptLine(speechEvent("Bob", ["hi"], AT))).toBe(
      "[2026-01-01 00:01:30] Bob: hi",
    );
  });
});
