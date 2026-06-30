import { describe, it, expect } from "bun:test";
import {
  newPresenceSnapshot,
  withSpeak,
  withChime,
  appendPresenceActivity,
  SPEAK_MAX_CHARS,
} from "../src/presence.ts";

describe("presence speak queue", () => {
  it("a new snapshot has speak null", () => {
    expect(newPresenceSnapshot().speak).toBeNull();
  });

  it("withSpeak sets text + at and bumps updated_at", () => {
    const base = newPresenceSnapshot("speaking", "Commenting");
    const next = withSpeak(base, "Hello world");
    expect(next.speak).not.toBeNull();
    expect(next.speak!.text).toBe("Hello world");
    expect(typeof next.speak!.at).toBe("string");
    expect(Number.isNaN(Date.parse(next.speak!.at))).toBe(false);
  });

  it("withSpeak collapses whitespace and ignores empty text", () => {
    const base = newPresenceSnapshot();
    expect(withSpeak(base, "   ").speak).toBeNull();
    expect(withSpeak(base, "a\nb\tc").speak!.text).toBe("a b c");
  });

  it("withSpeak truncates to the speak cap (longer than the message cap)", () => {
    expect(SPEAK_MAX_CHARS).toBeGreaterThan(160);
    const next = withSpeak(newPresenceSnapshot(), "x".repeat(SPEAK_MAX_CHARS + 50));
    expect(next.speak!.text.length).toBe(SPEAK_MAX_CHARS);
  });

  it("chime and activity updates preserve an existing speak", () => {
    const spoken = withSpeak(newPresenceSnapshot("speaking", "hi"), "say this");
    expect(withChime(spoken).speak?.text).toBe("say this");
    expect(
      appendPresenceActivity(spoken, { kind: "heard", label: "Nik", text: "hello" }).speak?.text,
    ).toBe("say this");
  });
});
