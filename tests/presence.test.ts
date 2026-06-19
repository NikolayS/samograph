import { describe, it, expect } from "bun:test";
import {
  PRESENCE_STATES,
  normalizePresenceState,
  defaultPresenceMessage,
  sanitizePresenceMessage,
  sanitizePresenceText,
  newPresenceSnapshot,
  appendPresenceActivity,
  activityFromTranscriptLine,
  withChime,
  presencePageHtml,
  type PresenceSnapshot,
} from "../src/presence.ts";

describe("normalizePresenceState", () => {
  it("accepts every canonical state", () => {
    for (const state of PRESENCE_STATES) {
      expect(normalizePresenceState(state)).toBe(state);
    }
  });

  it("normalizes mixed case to lowercase", () => {
    expect(normalizePresenceState("THINKING")).toBe("thinking");
    expect(normalizePresenceState("Thinking")).toBe("thinking");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePresenceState("  speaking  ")).toBe("speaking");
    expect(normalizePresenceState("\tIdle\n")).toBe("idle");
  });

  it("returns null for unknown states", () => {
    expect(normalizePresenceState("sleeping")).toBeNull();
    expect(normalizePresenceState("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(normalizePresenceState(null)).toBeNull();
    expect(normalizePresenceState(undefined)).toBeNull();
    expect(normalizePresenceState(42)).toBeNull();
    expect(normalizePresenceState({ state: "idle" })).toBeNull();
  });
});

describe("defaultPresenceMessage", () => {
  it("maps all five states to their default messages", () => {
    expect(defaultPresenceMessage("idle")).toBe("Idle");
    expect(defaultPresenceMessage("listening")).toBe("Listening");
    expect(defaultPresenceMessage("thinking")).toBe("Checking");
    expect(defaultPresenceMessage("speaking")).toBe("Commenting");
    expect(defaultPresenceMessage("acting")).toBe("Working");
  });
});

describe("sanitizePresenceMessage", () => {
  it("keeps a 159-char message intact", () => {
    const msg = "a".repeat(159);
    expect(sanitizePresenceMessage(msg, "idle")).toBe(msg);
  });

  it("keeps a 160-char message intact (boundary)", () => {
    const msg = "a".repeat(160);
    expect(sanitizePresenceMessage(msg, "idle")).toBe(msg);
  });

  it("truncates a 161-char message to 160", () => {
    const result = sanitizePresenceMessage("a".repeat(161), "idle");
    expect(result).toBe("a".repeat(160));
    expect(result.length).toBe(160);
  });

  it("collapses whitespace and CRLF runs to single spaces", () => {
    expect(sanitizePresenceMessage("hello\r\nworld\t\tagain   now", "idle")).toBe(
      "hello world again now",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizePresenceMessage("  hi there  ", "idle")).toBe("hi there");
  });

  it("falls back to the state default for non-strings", () => {
    expect(sanitizePresenceMessage(undefined, "thinking")).toBe("Checking");
    expect(sanitizePresenceMessage(123, "speaking")).toBe("Commenting");
  });

  it("falls back to the state default for whitespace-only strings", () => {
    expect(sanitizePresenceMessage("   \r\n\t ", "acting")).toBe("Working");
  });
});

describe("sanitizePresenceText", () => {
  it("caps at 220 chars by default", () => {
    expect(sanitizePresenceText("b".repeat(220))).toBe("b".repeat(220));
    expect(sanitizePresenceText("b".repeat(221))).toBe("b".repeat(220));
  });

  it("honors a custom maxLen (e.g. 40 for labels)", () => {
    expect(sanitizePresenceText("c".repeat(50), 40)).toBe("c".repeat(40));
    expect(sanitizePresenceText("short", 40)).toBe("short");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizePresenceText("  one\r\n two\t three  ")).toBe("one two three");
  });

  it("returns empty string for non-strings", () => {
    expect(sanitizePresenceText(undefined)).toBe("");
    expect(sanitizePresenceText(null)).toBe("");
    expect(sanitizePresenceText(7)).toBe("");
  });
});

describe("activityFromTranscriptLine", () => {
  it("parses a standard transcript line", () => {
    expect(
      activityFromTranscriptLine("[2026-06-09T10:00:00Z] Alice: hello there"),
    ).toEqual({ kind: "heard", label: "Alice", text: "hello there" });
  });

  it("keeps colons inside the utterance", () => {
    expect(
      activityFromTranscriptLine("[12:00:01] Bob: note: check the WAL: now"),
    ).toEqual({ kind: "heard", label: "Bob", text: "note: check the WAL: now" });
  });

  it("supports speaker names with spaces", () => {
    expect(
      activityFromTranscriptLine("[12:00:01] Alice Smith: agreed"),
    ).toEqual({ kind: "heard", label: "Alice Smith", text: "agreed" });
  });

  it("returns null for whitespace-only utterances", () => {
    expect(activityFromTranscriptLine("[12:00:01] Alice:    ")).toBeNull();
    expect(activityFromTranscriptLine("[12:00:01] Alice:")).toBeNull();
  });

  it("returns null for malformed lines", () => {
    // no leading bracketed timestamp
    expect(activityFromTranscriptLine("Alice: hello")).toBeNull();
    // no speaker colon
    expect(activityFromTranscriptLine("[12:00:01] just some text")).toBeNull();
    expect(activityFromTranscriptLine("")).toBeNull();
  });
});

describe("appendPresenceActivity", () => {
  it("returns the snapshot unchanged for whitespace-only text", () => {
    const snapshot = newPresenceSnapshot();
    const result = appendPresenceActivity(snapshot, {
      kind: "comment",
      label: "Comment",
      text: "   \r\n ",
    });
    expect(result).toBe(snapshot);
  });

  it("keeps at most 16 activities, newest first, oldest evicted", () => {
    let snapshot: PresenceSnapshot = newPresenceSnapshot();
    for (let i = 1; i <= 17; i++) {
      snapshot = appendPresenceActivity(snapshot, {
        kind: "heard",
        label: "Speaker",
        text: `utterance ${i}`,
      });
    }
    expect(snapshot.activities.length).toBe(16);
    // newest is prepended
    expect(snapshot.activities[0]!.text).toBe("utterance 17");
    // oldest ("utterance 1") was evicted
    expect(snapshot.activities[15]!.text).toBe("utterance 2");
    expect(
      snapshot.activities.some((a) => a.text === "utterance 1"),
    ).toBe(false);
  });

  it("preserves state and message, refreshes updated_at, stamps the activity", () => {
    const snapshot = newPresenceSnapshot("thinking", "Checking logs");
    const result = appendPresenceActivity(snapshot, {
      kind: "comment",
      label: "Comment",
      text: "found it",
    });
    expect(result.state).toBe("thinking");
    expect(result.message).toBe("Checking logs");
    expect(Number.isNaN(Date.parse(result.updated_at))).toBe(false);
    expect(result.activities[0]).toMatchObject({
      kind: "comment",
      label: "Comment",
      text: "found it",
    });
    expect(Number.isNaN(Date.parse(result.activities[0]!.at))).toBe(false);
  });

  it("falls back to the kind when the label is empty after sanitizing", () => {
    const result = appendPresenceActivity(newPresenceSnapshot(), {
      kind: "heard",
      label: "   ",
      text: "hello",
    });
    expect(result.activities[0]!.label).toBe("heard");
  });
});

describe("newPresenceSnapshot", () => {
  it("defaults to listening with the matching default message", () => {
    const snapshot = newPresenceSnapshot();
    expect(snapshot.state).toBe("listening");
    expect(snapshot.message).toBe("Listening");
    expect(snapshot.activities).toEqual([]);
    expect(Number.isNaN(Date.parse(snapshot.updated_at))).toBe(false);
  });

  it("accepts explicit state, message, and activities", () => {
    const activities = [
      { kind: "heard" as const, label: "Alice", text: "hi", at: new Date().toISOString() },
    ];
    const snapshot = newPresenceSnapshot("acting", "Opening PR", activities);
    expect(snapshot.state).toBe("acting");
    expect(snapshot.message).toBe("Opening PR");
    expect(snapshot.activities).toBe(activities);
  });

  it("starts with no chime", () => {
    expect(newPresenceSnapshot().chime).toBeNull();
  });
});

describe("withChime", () => {
  it("stamps a chime timestamp and bumps updated_at without touching activities", () => {
    const base = newPresenceSnapshot("listening", "Listening", [
      { kind: "heard" as const, label: "Alice", text: "hi", at: "2024-01-01T00:00:00.000Z" },
    ]);
    const next = withChime(base);
    expect(next.chime).not.toBeNull();
    expect(Number.isNaN(Date.parse(next.chime?.at ?? ""))).toBe(false);
    expect(next.state).toBe("listening");
    expect(next.activities).toBe(base.activities);
  });
});

describe("presencePageHtml polling", () => {
  it("starts the poll loop on every background, including the static robot avatar", () => {
    const html = presencePageHtml();
    const dispatch = html.slice(html.indexOf('if (backgroundMode === "robot")'));
    // The plasma-only branch ends here; pollLoop() must run after the dispatch,
    // not nested inside it, so the static robot avatar still polls for chimes.
    const elseClose = dispatch.indexOf("}", dispatch.indexOf("initFpsProbe();"));
    const pollAt = dispatch.indexOf("pollLoop();");
    expect(elseClose).toBeGreaterThan(-1);
    expect(pollAt).toBeGreaterThan(elseClose);
  });
});
