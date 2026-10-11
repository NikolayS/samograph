/**
 * Meeting-URL validation — red/green TDD, exact values (SPEC §5.2).
 *
 * `POST /calls` accepts ONLY a known Zoom or Google Meet meeting link; this is
 * the pure, DB-free half of that contract. Look-alike hosts
 * (`meet.google.com.evil.com`, `evilzoom.us`), non-https, and non-meeting URLs
 * MUST be rejected so the bot is never pointed at an attacker-chosen target.
 */
import { describe, it, expect } from "bun:test";
import { validateMeetingUrl } from "./validate.ts";

describe("validateMeetingUrl — accepts Zoom / Google Meet (§5.2)", () => {
  it("accepts a canonical Google Meet code URL", () => {
    expect(validateMeetingUrl("https://meet.google.com/abc-defg-hij")).toEqual({
      ok: true,
      provider: "meet",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("accepts a bare zoom.us /j/ join URL", () => {
    expect(validateMeetingUrl("https://zoom.us/j/1234567890")).toEqual({
      ok: true,
      provider: "zoom",
      url: "https://zoom.us/j/1234567890",
    });
  });

  it("accepts a Zoom vanity subdomain /j/ URL (preserving the query)", () => {
    expect(
      validateMeetingUrl("https://us02web.zoom.us/j/89012345678?pwd=secret"),
    ).toEqual({
      ok: true,
      provider: "zoom",
      url: "https://us02web.zoom.us/j/89012345678?pwd=secret",
    });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateMeetingUrl("  https://meet.google.com/abc-defg-hij  ")).toEqual({
      ok: true,
      provider: "meet",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });
});

describe("validateMeetingUrl — rejects everything else (§5.2)", () => {
  const rejected: Array<[string, unknown]> = [
    ["empty string", ""],
    ["non-string (null)", null],
    ["non-string (number)", 42],
    ["not a URL at all", "not a url"],
    ["a non-meeting https site", "https://example.com/meeting"],
    ["http (non-https) Meet", "http://meet.google.com/abc-defg-hij"],
    ["Meet host with no meeting code", "https://meet.google.com/"],
    ["Meet look-alike subdomain attack", "https://meet.google.com.evil.com/abc-defg-hij"],
    ["Zoom host suffix attack (evilzoom.us)", "https://evilzoom.us/j/1234567890"],
    ["Zoom host without a join path", "https://zoom.us/pricing"],
    ["Google host but not Meet", "https://google.com/abc-defg-hij"],
  ];

  for (const [label, input] of rejected) {
    it(`rejects ${label}`, () => {
      expect(validateMeetingUrl(input)).toEqual({ ok: false });
    });
  }
});
