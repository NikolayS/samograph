import { describe, it, expect } from "bun:test";
import {
  newPresenceSnapshot,
  withSpeak,
  withChime,
  appendPresenceActivity,
  presencePageHtml,
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

describe("presence page avatar mode", () => {
  const html = presencePageHtml();

  it("recognizes the avatar background mode", () => {
    expect(html).toContain('"avatar"');
    expect(html).toContain("initAvatar");
  });

  it("fetches the session token from the server (key never in the page)", () => {
    expect(html).toContain("/avatar/session");
    // The API key lives only server-side; the page must not embed a bearer.
    expect(html).not.toContain("Bearer ");
    expect(html).not.toContain("ANAM_API_KEY");
  });

  it("imports the pinned Anam SDK and attaches the stream to a video element", () => {
    expect(html).toContain("esm.sh/@anam-ai/js-sdk@4.17.1");
    expect(html).toContain("streamToVideoElement");
    expect(html).toContain("disableInputAudio");
  });

  it("speaks each new speak line via the talk() command and falls back on failure", () => {
    expect(html).toContain("handleSpeak");
    expect(html).toContain(".talk(");
    expect(html).toContain("showRobotFullFrame");
  });

  it("polls faster in avatar mode (snappier spoken reactions) than other modes", () => {
    expect(html).toContain('backgroundMode === "avatar"');
    expect(html).toContain("? 300 : 2000");
    // other modes keep the conservative cadence
    expect(html).toContain("? 1000 : 5000");
  });
});
