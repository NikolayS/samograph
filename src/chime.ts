import { CHIME_LIBRARY, DEFAULT_CHIME } from "./chimeLibrary.ts";

// Public registry of selectable chime sounds. The audible path (chat.ts ->
// recall.outputAudio) plays the resolved MP3 into the call; selection is set
// per-message via `chat --chime`, or per-session via `join --chime` (stored in
// state). See scripts/gen-chimes.sh for how the MP3s are produced.

export { DEFAULT_CHIME } from "./chimeLibrary.ts";

// Display order matches the library insertion order (blip first).
export function chimeNames(): string[] {
  return Object.keys(CHIME_LIBRARY);
}

export function isChimeName(value: unknown): value is string {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(CHIME_LIBRARY, value);
}

// Normalize a user-supplied name: trim + lowercase. Returns "" for non-strings.
export function normalizeChimeName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export interface ResolvedChime {
  name: string;
  mp3Base64: string;
  // True when the requested name was unknown and we fell back to the default.
  fellBack: boolean;
}

// Resolve a requested chime name to its asset. Unknown/empty names fall back to
// the default chime and set `fellBack` so the caller can warn. An empty/absent
// request is NOT a fallback — it just means "use the default" silently.
export function resolveChime(requested?: unknown): ResolvedChime {
  const normalized = normalizeChimeName(requested);
  if (normalized && isChimeName(normalized)) {
    return { name: normalized, mp3Base64: CHIME_LIBRARY[normalized]!, fellBack: false };
  }
  const fellBack = normalized.length > 0; // a real, but unknown, name was given
  return { name: DEFAULT_CHIME, mp3Base64: CHIME_LIBRARY[DEFAULT_CHIME]!, fellBack };
}
