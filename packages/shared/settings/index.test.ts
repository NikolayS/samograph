/**
 * Per-tenant hosted Settings model — unit suite (SPEC §5.12).
 *
 * The hosted Settings surface reuses the CLI's dictionary (`src/dict.ts`
 * PostgresFM preset + user terms) and chime (`src/chime.ts` ids) constants — it
 * MUST NOT fork them. This suite pins the defaults, validation, wire mapping, and
 * the effective-keyterms resolution that the app-api route and the bot-orchestrator
 * transcription config both consume.
 */
import { describe, it, expect } from "bun:test";
import { DEFAULT_CHIME, chimeNames } from "../../../src/chime.ts";
import {
  DEFAULT_SETTINGS,
  DEFAULT_LANGUAGE,
  DICTIONARY_PRESETS,
  LANGUAGE_OPTIONS,
  MAX_KEYTERMS,
  isDictionaryPreset,
  isLanguageCode,
  normalizeKeyterms,
  parseSettingsBody,
  resolveKeyterms,
  settingsOptions,
  toWire,
  type TenantSettings,
} from "./index.ts";

describe("§5.12 defaults", () => {
  it("first-GET defaults: no preset, no user terms, multilingual, default chime", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      dictionaryPreset: "none",
      keyterms: [],
      language: "multi",
      chime: DEFAULT_CHIME,
    });
    expect(DEFAULT_LANGUAGE).toBe("multi");
  });

  it("reuses (does not fork) the CLI chime ids — DEFAULT_CHIME is a real chime", () => {
    expect(chimeNames()).toContain(DEFAULT_CHIME);
  });

  it("ships the PostgresFM preset as a selectable dictionary preset (§5.12)", () => {
    expect([...DICTIONARY_PRESETS]).toContain("none");
    expect([...DICTIONARY_PRESETS]).toContain("postgresfm");
  });

  it("offers multilingual auto-detect plus specific Deepgram languages (§5.12)", () => {
    const codes = LANGUAGE_OPTIONS.map((o) => o.code);
    expect(codes).toContain("multi");
    expect(codes).toContain("en");
    expect(codes).toContain("es");
  });
});

describe("§5.12 field validation", () => {
  it("accepts only shipped dictionary presets", () => {
    expect(isDictionaryPreset("postgresfm")).toBe(true);
    expect(isDictionaryPreset("none")).toBe(true);
    expect(isDictionaryPreset("bogus")).toBe(false);
    expect(isDictionaryPreset(42)).toBe(false);
  });

  it("accepts only Deepgram-supported language codes", () => {
    expect(isLanguageCode("multi")).toBe(true);
    expect(isLanguageCode("es")).toBe(true);
    expect(isLanguageCode("klingon")).toBe(false);
    expect(isLanguageCode(null)).toBe(false);
  });

  it("normalizeKeyterms trims, drops empties, dedupes (case-insensitive), caps count", () => {
    const raw = ["  WAL ", "wal", "", "  ", "Postgres", "Postgres"];
    expect(normalizeKeyterms(raw)).toEqual(["WAL", "Postgres"]);
    const many = Array.from({ length: MAX_KEYTERMS + 20 }, (_, i) => `term_${i}`);
    expect(normalizeKeyterms(many).length).toBe(MAX_KEYTERMS);
  });

  it("normalizeKeyterms rejects non-array / non-string entries gracefully", () => {
    expect(normalizeKeyterms(undefined)).toEqual([]);
    expect(normalizeKeyterms([1, "ok", null, "ok2"] as unknown[])).toEqual(["ok", "ok2"]);
  });
});

describe("§5.12 parseSettingsBody (PUT contract)", () => {
  it("round-trips a full valid document (snake_case wire → camelCase domain)", () => {
    const parsed = parseSettingsBody({
      dictionary_preset: "postgresfm",
      keyterms: ["pg_stat_statements", "WAL"],
      language: "es",
      chime: "bell",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      dictionaryPreset: "postgresfm",
      keyterms: ["pg_stat_statements", "WAL"],
      language: "es",
      chime: "bell",
    });
  });

  it("fills missing fields with defaults (full-document replace, forgiving)", () => {
    const parsed = parseSettingsBody({ language: "en" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      dictionaryPreset: "none",
      keyterms: [],
      language: "en",
      chime: DEFAULT_CHIME,
    });
  });

  it("rejects an invalid language / preset / chime with a typed message", () => {
    expect(parseSettingsBody({ language: "klingon" }).ok).toBe(false);
    expect(parseSettingsBody({ dictionary_preset: "bogus" }).ok).toBe(false);
    expect(parseSettingsBody({ chime: "not-a-chime" }).ok).toBe(false);
    const bad = parseSettingsBody({ language: "klingon" });
    if (!bad.ok) expect(bad.message.length).toBeGreaterThan(0);
  });

  it("rejects a non-object body", () => {
    expect(parseSettingsBody(null).ok).toBe(false);
    expect(parseSettingsBody("nope").ok).toBe(false);
  });
});

describe("§5.12 toWire (GET/PUT response shape)", () => {
  it("serializes camelCase domain → snake_case wire", () => {
    const s: TenantSettings = {
      dictionaryPreset: "postgresfm",
      keyterms: ["WAL"],
      language: "de",
      chime: "glass",
    };
    expect(toWire(s)).toEqual({
      dictionary_preset: "postgresfm",
      keyterms: ["WAL"],
      language: "de",
      chime: "glass",
    });
  });

  it("settingsOptions advertises the full choice catalog for the UI", () => {
    const opts = settingsOptions();
    expect(opts.chimes).toContain(DEFAULT_CHIME);
    expect(opts.presets).toContain("postgresfm");
    expect(opts.languages.map((l) => l.code)).toContain("multi");
  });
});

describe("§5.12 resolveKeyterms — effective Deepgram keyterms", () => {
  it("preset 'none' → exactly the user terms (no preset injected)", () => {
    const s: TenantSettings = {
      dictionaryPreset: "none",
      keyterms: ["pg_stat_statements", "autovacuum"],
      language: "multi",
      chime: DEFAULT_CHIME,
    };
    expect(resolveKeyterms(s)).toEqual(["pg_stat_statements", "autovacuum"]);
  });

  it("preset 'postgresfm' → preset terms plus user terms, deduped, capped at 100", () => {
    const s: TenantSettings = {
      dictionaryPreset: "postgresfm",
      keyterms: ["MyCustomTerm"],
      language: "multi",
      chime: DEFAULT_CHIME,
    };
    const resolved = resolveKeyterms(s);
    // The shipped preset (dictionaries/postgresfm.txt) contributes a known term.
    expect(resolved).toContain("Nikolay Samokhvalov");
    expect(resolved).toContain("MyCustomTerm");
    expect(resolved.length).toBeLessThanOrEqual(MAX_KEYTERMS);
  });
});
