import { describe, it, expect } from "bun:test";
import {
  chimeNames,
  DEFAULT_CHIME,
  isChimeName,
  normalizeChimeName,
  resolveChime,
} from "../src/chime.ts";
import { CHIME_LIBRARY } from "../src/chimeLibrary.ts";

describe("chime registry", () => {
  it("exposes ~10 distinct named chimes", () => {
    const names = chimeNames();
    expect(names.length).toBe(10);
    expect(new Set(names).size).toBe(names.length);
  });

  it("lists blip first and includes it as the default", () => {
    expect(DEFAULT_CHIME).toBe("blip");
    expect(chimeNames()[0]).toBe("blip");
    expect(chimeNames()).toContain(DEFAULT_CHIME);
  });

  it("every chime resolves to a non-empty base64 MP3 asset", () => {
    for (const name of chimeNames()) {
      const asset = CHIME_LIBRARY[name]!;
      expect(asset.length).toBeGreaterThan(0);
      // Base64 alphabet only (chunks were concatenated, so no separators).
      expect(asset).toMatch(/^[A-Za-z0-9+/=]+$/);
    }
  });

  it("isChimeName recognizes known names and rejects others", () => {
    expect(isChimeName("blip")).toBe(true);
    expect(isChimeName("bell")).toBe(true);
    expect(isChimeName("nope")).toBe(false);
    expect(isChimeName("")).toBe(false);
    expect(isChimeName(undefined)).toBe(false);
    expect(isChimeName(42)).toBe(false);
    // Guard against inherited Object props leaking through.
    expect(isChimeName("toString")).toBe(false);
    expect(isChimeName("constructor")).toBe(false);
  });

  it("normalizeChimeName trims and lowercases", () => {
    expect(normalizeChimeName("  Bell  ")).toBe("bell");
    expect(normalizeChimeName("TWO-TONE")).toBe("two-tone");
    expect(normalizeChimeName(123)).toBe("");
  });
});

describe("resolveChime", () => {
  it("resolves a known name to its own asset (no fallback)", () => {
    const r = resolveChime("bell");
    expect(r.name).toBe("bell");
    expect(r.fellBack).toBe(false);
    expect(r.mp3Base64).toBe(CHIME_LIBRARY["bell"]!);
  });

  it("resolves case-insensitively and trims whitespace", () => {
    const r = resolveChime("  MARIMBA ");
    expect(r.name).toBe("marimba");
    expect(r.fellBack).toBe(false);
  });

  it("defaults silently for an empty/absent request (not a fallback)", () => {
    for (const req of [undefined, null, "", "   "]) {
      const r = resolveChime(req as unknown);
      expect(r.name).toBe(DEFAULT_CHIME);
      expect(r.fellBack).toBe(false);
      expect(r.mp3Base64).toBe(CHIME_LIBRARY[DEFAULT_CHIME]!);
    }
  });

  it("falls back to the default and flags it for an unknown name", () => {
    const r = resolveChime("kazoo");
    expect(r.name).toBe(DEFAULT_CHIME);
    expect(r.fellBack).toBe(true);
    expect(r.mp3Base64).toBe(CHIME_LIBRARY[DEFAULT_CHIME]!);
  });

  it("different chimes resolve to different assets", () => {
    expect(resolveChime("blip").mp3Base64).not.toBe(resolveChime("bell").mp3Base64);
    expect(resolveChime("rising").mp3Base64).not.toBe(resolveChime("falling").mp3Base64);
  });
});
