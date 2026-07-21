/**
 * Per-tenant hosted Settings model (SPEC §5.12).
 *
 * This is the SERVER-SIDE source of truth for the hosted Settings surface. It
 * REUSES the CLI's dictionary and chime primitives rather than forking them:
 *   - the PostgresFM dictionary preset + `loadDict` from `src/dict.ts`;
 *   - the selectable chime ids + validation from `src/chime.ts`.
 * The app-api `/settings` route and the bot-orchestrator transcription config
 * both consume this module, so the settings a tenant saves map DIRECTLY onto
 * Deepgram keyterm prompting + language (§5.12), and the chime the bot plays.
 *
 * Wire shape is snake_case (`dictionary_preset`, matching the DB columns and the
 * HTTP body); the TS domain shape is camelCase. Mapping lives here.
 *
 * NOTE: this module imports `src/dict.ts` (node:fs) and `src/chime.ts` (the
 * inlined chime library); it is intended for the Node/Bun backend only, never
 * the browser bundle. The web renders its option catalog from the API response.
 */
import { loadDict } from "../../../src/dict.ts";
import { chimeNames, isChimeName, normalizeChimeName, DEFAULT_CHIME } from "../../../src/chime.ts";

export { DEFAULT_CHIME, chimeNames };

/** Shipped dictionary presets (§5.12). `none` = user terms only; `postgresfm` ships. */
export const DICTIONARY_PRESETS = ["none", "postgresfm"] as const;
export type DictionaryPreset = (typeof DICTIONARY_PRESETS)[number];

/**
 * Deepgram-supported languages offered in the UI (§5.12). `multi` = multilingual
 * auto-detect (Nova multilingual, the code-switching differentiator); the rest
 * are specific single-language codes. This is a curated subset — extend as needed.
 */
export const LANGUAGE_OPTIONS = [
  { code: "multi", label: "Multilingual (auto-detect)" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
] as const;

const LANGUAGE_CODE_SET = new Set<string>(LANGUAGE_OPTIONS.map((o) => o.code));

/** Default language: multilingual auto-detect (matches the pre-settings hardwired value). */
export const DEFAULT_LANGUAGE = "multi";

/** Deepgram keyterm cap (mirrors `src/dict.ts`'s `slice(0, 100)`). */
export const MAX_KEYTERMS = 100;
/** Defensive per-term length cap so one pasted blob can't bloat the payload. */
export const MAX_KEYTERM_LENGTH = 120;

/** The camelCase domain shape of a tenant's settings. */
export interface TenantSettings {
  dictionaryPreset: DictionaryPreset;
  /** User-defined additional keyterms (the preset is layered on at resolve time). */
  keyterms: string[];
  language: string;
  chime: string;
}

/** The §5.12 defaults returned on a first GET (no persisted row yet). */
export const DEFAULT_SETTINGS: TenantSettings = {
  dictionaryPreset: "none",
  keyterms: [],
  language: DEFAULT_LANGUAGE,
  chime: DEFAULT_CHIME,
};

/** The snake_case wire shape (HTTP body + DB columns). */
export interface SettingsWire {
  dictionary_preset: DictionaryPreset;
  keyterms: string[];
  language: string;
  chime: string;
}

export interface SettingsOptions {
  chimes: string[];
  languages: { code: string; label: string }[];
  presets: string[];
}

export type SettingsValidation =
  | { ok: true; value: TenantSettings }
  | { ok: false; message: string };

export function isDictionaryPreset(v: unknown): v is DictionaryPreset {
  return typeof v === "string" && (DICTIONARY_PRESETS as readonly string[]).includes(v);
}

export function isLanguageCode(v: unknown): v is string {
  return typeof v === "string" && LANGUAGE_CODE_SET.has(v);
}

/**
 * Normalize a user-supplied keyterms list: keep only strings, trim, drop empties,
 * cap each term's length, dedupe case-insensitively (first wins), and cap the
 * count at {@link MAX_KEYTERMS}. Non-array input yields `[]`.
 */
export function normalizeKeyterms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().slice(0, MAX_KEYTERM_LENGTH).trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

/**
 * Validate + normalize a PUT body into a full {@link TenantSettings} document.
 * A full-document replace, but FORGIVING of missing fields (they fall back to the
 * §5.12 defaults); a field that is PRESENT but invalid is rejected with a typed
 * message so the client sees exactly what was wrong (never a silent coercion).
 */
export function parseSettingsBody(body: unknown): SettingsValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "settings body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  let dictionaryPreset: DictionaryPreset = DEFAULT_SETTINGS.dictionaryPreset;
  if (b.dictionary_preset !== undefined) {
    if (!isDictionaryPreset(b.dictionary_preset)) {
      return { ok: false, message: `unknown dictionary preset: ${String(b.dictionary_preset)}` };
    }
    dictionaryPreset = b.dictionary_preset;
  }

  let language = DEFAULT_SETTINGS.language;
  if (b.language !== undefined) {
    if (!isLanguageCode(b.language)) {
      return { ok: false, message: `unsupported language: ${String(b.language)}` };
    }
    language = b.language;
  }

  let chime = DEFAULT_SETTINGS.chime;
  if (b.chime !== undefined) {
    const norm = normalizeChimeName(b.chime);
    if (!isChimeName(norm)) {
      return { ok: false, message: `unknown chime: ${String(b.chime)}` };
    }
    chime = norm;
  }

  const keyterms = b.keyterms === undefined ? [] : normalizeKeyterms(b.keyterms);

  return { ok: true, value: { dictionaryPreset, keyterms, language, chime } };
}

/** camelCase domain → snake_case wire (GET/PUT response + DB write). */
export function toWire(s: TenantSettings): SettingsWire {
  return {
    dictionary_preset: s.dictionaryPreset,
    keyterms: s.keyterms,
    language: s.language,
    chime: s.chime,
  };
}

/** A persisted `settings` row → the domain shape (trusted; light coercion only). */
export function fromRow(row: {
  dictionary_preset: string;
  keyterms: string[] | null;
  language: string;
  chime: string;
}): TenantSettings {
  return {
    dictionaryPreset: isDictionaryPreset(row.dictionary_preset) ? row.dictionary_preset : "none",
    keyterms: Array.isArray(row.keyterms) ? row.keyterms : [],
    language: row.language,
    chime: row.chime,
  };
}

/** The full choice catalog the UI renders its selects from. */
export function settingsOptions(): SettingsOptions {
  return {
    chimes: chimeNames(),
    languages: LANGUAGE_OPTIONS.map((o) => ({ code: o.code, label: o.label })),
    presets: [...DICTIONARY_PRESETS],
  };
}

/**
 * The EFFECTIVE Deepgram keyterms for a tenant: the selected preset's terms
 * layered UNDER the user's own terms (user terms first so they are never dropped
 * by the {@link MAX_KEYTERMS} cap), deduped case-insensitively. `none` → just the
 * user terms. This is what the bot-orchestrator passes to Deepgram (§5.12).
 */
export function resolveKeyterms(s: TenantSettings): string[] {
  const preset = s.dictionaryPreset === "none" ? [] : loadDict(s.dictionaryPreset);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of [...s.keyterms, ...preset]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}
