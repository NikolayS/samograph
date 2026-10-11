import { describe, it, expect } from "bun:test";
import { validateMeetingUrl } from "./validateMeetingUrl.ts";

describe("validateMeetingUrl — client-side URL-shape check (SPEC §5.2)", () => {
  it("ACCEPTS a canonical Google Meet URL", () => {
    expect(validateMeetingUrl("https://meet.google.com/abc-defg-hij")).toEqual({
      ok: true,
      provider: "google_meet",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("ACCEPTS a canonical Zoom URL", () => {
    expect(validateMeetingUrl("https://zoom.us/j/123456789")).toEqual({
      ok: true,
      provider: "zoom",
      url: "https://zoom.us/j/123456789",
    });
  });

  it("ACCEPTS a Zoom vanity subdomain with a query string", () => {
    expect(validateMeetingUrl("https://us02web.zoom.us/j/123?pwd=secret")).toEqual({
      ok: true,
      provider: "zoom",
      url: "https://us02web.zoom.us/j/123?pwd=secret",
    });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateMeetingUrl("  https://meet.google.com/abc-defg-hij  ")).toEqual({
      ok: true,
      provider: "google_meet",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("REJECTS an empty string", () => {
    expect(validateMeetingUrl("")).toEqual({ ok: false, reason: "empty" });
  });

  it("REJECTS whitespace-only input", () => {
    expect(validateMeetingUrl("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("REJECTS a non-URL string", () => {
    expect(validateMeetingUrl("not a url")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("REJECTS a non-https scheme", () => {
    expect(validateMeetingUrl("http://meet.google.com/abc-defg-hij")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("REJECTS a non-meeting host", () => {
    expect(validateMeetingUrl("https://example.com/whatever")).toEqual({
      ok: false,
      reason: "unsupported_host",
    });
  });

  it("REJECTS a look-alike host that only ends with zoom.us via another domain", () => {
    expect(validateMeetingUrl("https://evil-zoom.us.attacker.com/j/1")).toEqual({
      ok: false,
      reason: "unsupported_host",
    });
  });

  it("REJECTS a known host with no meeting path", () => {
    expect(validateMeetingUrl("https://meet.google.com/")).toEqual({
      ok: false,
      reason: "missing_meeting_path",
    });
    expect(validateMeetingUrl("https://zoom.us")).toEqual({
      ok: false,
      reason: "missing_meeting_path",
    });
  });
});
