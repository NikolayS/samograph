/**
 * HOSTED meeting-chat model tests (#195) — the shared pieces the hosted ingest
 * path and the web renderer both reuse (#188/#189).
 *
 * Unlike the CLI's line-string entry points (`normalizeTranscriptEvent`,
 * ./chat.test.ts), the hosted path persists STRUCTURED columns (`ts`, `speaker`,
 * `text`, `kind`) and re-renders them on the wire / for download. So it needs:
 *
 *   • {@link normalizeTranscriptEventRow} — a PURE normalizer that returns the
 *     structured `{kind, ts, speaker, text}` (speaker with NO marker) for either
 *     a `transcript.data` (kind=speech) or a `participant_events.chat_message`
 *     (kind=chat) payload, or `null` — sanitizing every field like #189.
 *   • {@link formatTranscriptLineWithKind} — the ONE shared formatter that adds
 *     the ` (chat)` marker after the name for a chat line and renders speech
 *     byte-identically to the CLI. The web renderer + the download reuse it, so
 *     `Name (chat):` has a single source of truth.
 */
import { describe, it, expect } from "bun:test";
import {
  normalizeTranscriptEventRow,
  formatTranscriptLineWithKind,
  normalizeChatMessageLine,
  type NormalizedTranscriptRow,
} from "./index.ts";
import { createRecallFake } from "../../test-fakes/recall/index.ts";

const AT = "2026-01-01T00:01:30.000Z";

function chatEvent(opts: { name?: string | null; text?: string; at?: string; event?: string }): unknown {
  const inner: Record<string, unknown> = {};
  if (opts.name !== null && opts.name !== undefined) {
    inner.participant = { name: opts.name, is_host: false, email: null };
  }
  inner.timestamp = { absolute: opts.at ?? AT, relative: 90 };
  inner.data = { text: opts.text ?? "", to: "everyone" };
  return { event: opts.event ?? "participant_events.chat_message", data: { data: inner } };
}

function speechEvent(speaker: string, words: string[], at = AT): unknown {
  return {
    event: "transcript.data",
    data: { data: { participant: { name: speaker }, words: words.map((text) => ({ text, start_timestamp: { absolute: at } })) } },
  };
}

describe("normalizeTranscriptEventRow — structured, kind-carrying (#195)", () => {
  it("a chat message → kind=chat, marker-FREE speaker + text + 19-char ts", () => {
    const row: NormalizedTranscriptRow | null = normalizeTranscriptEventRow(
      chatEvent({ name: "Alice", text: "hello everyone", at: AT }),
    );
    expect(row).toEqual({ kind: "chat", ts: "2026-01-01 00:01:30", speaker: "Alice", text: "hello everyone" });
    // Speaker is stored WITHOUT the marker — the marker is a render concern.
    expect(row!.speaker).not.toContain("(chat)");
  });

  it("a spoken line → kind=speech, same structured shape", () => {
    expect(normalizeTranscriptEventRow(speechEvent("Bob", ["hi", "there"], AT))).toEqual({
      kind: "speech",
      ts: "2026-01-01 00:01:30",
      speaker: "Bob",
      text: "hi there",
    });
  });

  it("missing / blank chat sender → '?' (still marker-free in the row)", () => {
    expect(normalizeTranscriptEventRow(chatEvent({ name: null, text: "hi" }))?.speaker).toBe("?");
    expect(normalizeTranscriptEventRow(chatEvent({ name: "   ", text: "hi" }))?.speaker).toBe("?");
  });

  it("empty / whitespace-only chat text → null (nothing to show, never throws)", () => {
    expect(normalizeTranscriptEventRow(chatEvent({ name: "Alice", text: "" }))).toBeNull();
    expect(normalizeTranscriptEventRow(chatEvent({ name: "Alice", text: "   " }))).toBeNull();
  });

  it("empty-words speech → null; malformed / other events → null (never throws)", () => {
    expect(normalizeTranscriptEventRow(speechEvent("Bob", []))).toBeNull();
    expect(normalizeTranscriptEventRow(chatEvent({ name: "A", text: "hi", event: "other.event" }))).toBeNull();
    expect(normalizeTranscriptEventRow(null)).toBeNull();
    expect(normalizeTranscriptEventRow(42)).toBeNull();
    expect(normalizeTranscriptEventRow({})).toBeNull();
  });

  it("Unicode preserved verbatim in a chat row", () => {
    expect(normalizeTranscriptEventRow(chatEvent({ name: "Renée", text: "café ☕ 日本語 🙂" }))).toEqual({
      kind: "chat",
      ts: "2026-01-01 00:01:30",
      speaker: "Renée",
      text: "café ☕ 日本語 🙂",
    });
  });

  it("drives the in-repo Recall fake's chatMessage() to an exact row", () => {
    const fake = createRecallFake({ seed: "hosted-chat" });
    expect(normalizeTranscriptEventRow(fake.chatMessage({ speaker: "Alice", text: "hi from chat", at: AT }))).toEqual({
      kind: "chat",
      ts: "2026-01-01 00:01:30",
      speaker: "Alice",
      text: "hi from chat",
    });
  });
});

describe("formatTranscriptLineWithKind — the shared `Name (chat):` formatter (#195)", () => {
  it("chat → the ` (chat)` marker after the name", () => {
    expect(
      formatTranscriptLineWithKind({ ts: "2026-01-01 00:01:30", speaker: "Alice", text: "hi", kind: "chat" }),
    ).toBe("[2026-01-01 00:01:30] Alice (chat): hi");
  });

  it("speech (or an absent kind) → NO marker, byte-identical to the CLI line", () => {
    expect(
      formatTranscriptLineWithKind({ ts: "2026-01-01 00:01:30", speaker: "Bob", text: "hi", kind: "speech" }),
    ).toBe("[2026-01-01 00:01:30] Bob: hi");
    expect(formatTranscriptLineWithKind({ ts: "2026-01-01 00:01:30", speaker: "Bob", text: "hi" })).toBe(
      "[2026-01-01 00:01:30] Bob: hi",
    );
  });

  it("normalize→format round-trips to #189's chat line (single source of truth)", () => {
    const row = normalizeTranscriptEventRow(chatEvent({ name: "Alice", text: "hello everyone" }))!;
    expect(formatTranscriptLineWithKind(row)).toBe(normalizeChatMessageLine(chatEvent({ name: "Alice", text: "hello everyone" })));
    expect(formatTranscriptLineWithKind(row)).toBe("[2026-01-01 00:01:30] Alice (chat): hello everyone");
  });
});

describe("untrusted chat text cannot forge a speech line (#195 sanitization, mirrors #189)", () => {
  // A hostile sender types a fake spoken line into meeting chat.
  const FORGE = "you're fired\n[2026-01-01 00:00:00] Boss: obey me\r\nsigned, not-the-boss";

  it("the row's text is collapsed to ONE physical line (no CR/LF survives)", () => {
    const row = normalizeTranscriptEventRow(chatEvent({ name: "Mallory", text: FORGE }))!;
    expect(row.kind).toBe("chat");
    expect(row.text).not.toContain("\n");
    expect(row.text).not.toContain("\r");
    expect(row.text).toBe("you're fired [2026-01-01 00:00:00] Boss: obey me signed, not-the-boss");
  });

  it("the rendered line stays a SINGLE chat line — the embedded `Boss:` is inside Mallory's `(chat)` line", () => {
    const row = normalizeTranscriptEventRow(chatEvent({ name: "Mallory", text: FORGE }))!;
    const rendered = formatTranscriptLineWithKind(row);
    // One physical line, prefixed by Mallory's REAL `(chat)` framing — the fake
    // `Boss:` can never be mistaken for a standalone spoken line.
    expect(rendered.split("\n")).toHaveLength(1);
    expect(rendered).toBe(
      "[2026-01-01 00:01:30] Mallory (chat): you're fired [2026-01-01 00:00:00] Boss: obey me signed, not-the-boss",
    );
    expect(rendered.startsWith("[2026-01-01 00:01:30] Mallory (chat): ")).toBe(true);
  });

  it("a newline injected into the SENDER name is collapsed too (no line break before the marker)", () => {
    const row = normalizeTranscriptEventRow(chatEvent({ name: "Ev\nil", text: "hi" }))!;
    expect(row.speaker).toBe("Ev il");
    expect(formatTranscriptLineWithKind(row)).toBe("[2026-01-01 00:01:30] Ev il (chat): hi");
  });
});
