import { describe, expect, it } from "bun:test";
import { relativeTime } from "./relativeTime.ts";

/**
 * The dashboard row's meta line answers "when was this?" in one glance
 * (mobile audit M7: a row is currently three lines that say nothing). Exact
 * values, fixed `now`, so the copy cannot drift.
 */
const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  it("says 'just now' under a minute", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59_000), NOW)).toBe("just now");
  });

  it("counts whole minutes under an hour", () => {
    expect(relativeTime(ago(60_000), NOW)).toBe("1 min ago");
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe("59 min ago");
  });

  it("counts whole hours under a day", () => {
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe("1 h ago");
    expect(relativeTime(ago(23 * 60 * 60_000), NOW)).toBe("23 h ago");
  });

  it("counts whole days under a week", () => {
    expect(relativeTime(ago(24 * 60 * 60_000), NOW)).toBe("1 d ago");
    expect(relativeTime(ago(6 * 24 * 60 * 60_000), NOW)).toBe("6 d ago");
  });

  it("falls back to a date past a week", () => {
    expect(relativeTime("2026-08-12T12:00:00.000Z", NOW)).toBe("12 Aug");
    // A different year keeps the year, so an old call is never mistaken for a recent one.
    expect(relativeTime("2025-12-31T12:00:00.000Z", NOW)).toBe("31 Dec 2025");
  });

  it("returns an empty string for a missing or unparseable timestamp", () => {
    expect(relativeTime(undefined, NOW)).toBe("");
    expect(relativeTime("", NOW)).toBe("");
    expect(relativeTime("not a date", NOW)).toBe("");
  });

  it("never shows a negative age for a clock-skewed future timestamp", () => {
    expect(relativeTime(new Date(NOW + 90_000).toISOString(), NOW)).toBe("just now");
  });
});
