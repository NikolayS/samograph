// Text-side helpers for `samograph say`: language detection, sentence
// chunking, and the "don't over-talk" brevity policy. Pure functions — no I/O —
// so the policy is easy to test and reason about.

export type SpeechLang = "ru" | "en";

/** Default spoken-length limit, in words (~15 s at a normal speaking rate). */
export const DEFAULT_MAX_WORDS = 40;
/** Default quiet period between two normal-priority utterances, in seconds. */
export const DEFAULT_COOLDOWN_SECONDS = 15;
/** Chunks longer than this are split further so barge-in can cut in sooner. */
export const MAX_CHUNK_WORDS = 25;

/** "auto" picks ru when the text has more Cyrillic than Latin letters. */
export function detectLang(text: string, requested: string | null | undefined = "auto"): SpeechLang {
  if (requested === "ru" || requested === "en") return requested;
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  return cyr > lat ? "ru" : "en";
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Split text into sentences (on . ! ? … and line breaks), dropping empties. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function splitLongSentence(sentence: string, maxWords: number): string[] {
  if (countWords(sentence) <= maxWords) return [sentence];
  // Prefer clause boundaries (, ; : —), then fall back to fixed word windows.
  const clauses = sentence.split(/(?<=[,;:—])\s+/);
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) out.push(cur.join(" "));
    cur = [];
  };
  for (const clause of clauses) {
    const words = clause.split(/\s+/).filter(Boolean);
    if (cur.length + words.length > maxWords) flush();
    if (words.length > maxWords) {
      for (let i = 0; i < words.length; i += maxWords) {
        out.push(words.slice(i, i + maxWords).join(" "));
      }
      continue;
    }
    cur.push(...words);
  }
  flush();
  return out;
}

/**
 * Split text into short, separately playable chunks: one sentence each, and
 * long sentences split at clause boundaries so no chunk exceeds maxWords.
 * Short chunks make barge-in effective: at worst one sentence plays out.
 */
export function chunkText(text: string, maxWords: number = MAX_CHUNK_WORDS): string[] {
  return splitSentences(text).flatMap((s) => splitLongSentence(s, maxWords));
}

/** Leading whole sentences that fit within maxWords (the first one is word-capped). */
export function truncateToWords(text: string, maxWords: number): string {
  const sentences = splitSentences(text);
  const kept: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const n = countWords(s);
    if (kept.length === 0 && n > maxWords) {
      return s.split(/\s+/).slice(0, maxWords).join(" ") + "…";
    }
    if (words + n > maxWords) break;
    kept.push(s);
    words += n;
  }
  return kept.join(" ");
}

export function defaultAskText(lang: SpeechLang, topic?: string | null): string {
  const t = topic?.trim();
  if (lang === "ru") {
    return t
      ? `У меня есть более подробный комментарий про ${t}, я написал его в чат. Зачитать вслух?`
      : "У меня есть более подробный комментарий, я написал его в чат. Зачитать вслух?";
  }
  return t
    ? `I have a longer note on ${t}. I posted it in the chat. Want me to read it out?`
    : "I have a longer note. I posted it in the chat. Want me to read it out?";
}

export type LongTextMode = "ask" | "truncate";

export interface SpeechPlan {
  /** What will be spoken into the call. */
  spoken: string;
  /** Full text to post to meeting chat, or null when nothing is posted. */
  chat: string | null;
  /** Which branch of the brevity policy applied. */
  policy: "full" | "ask" | "truncate";
  words: number;
}

export interface PlanOptions {
  maxWords: number; // 0 = no limit
  longMode: LongTextMode;
  alsoChat: boolean;
  lang: SpeechLang;
  topic?: string | null;
  askText?: string | null;
}

/**
 * The "don't over-talk" policy. Text within maxWords is spoken as-is. Longer
 * text is NOT read out by default: the bot says a one-line ask ("I have a
 * longer note… want me to read it out?") and posts the full text to chat
 * (mode "ask"). Mode "truncate" speaks the leading sentences that fit and
 * posts the full text to chat. maxWords = 0 disables the limit.
 */
export function planSpeech(text: string, opts: PlanOptions): SpeechPlan {
  const clean = text.trim();
  const words = countWords(clean);
  if (opts.maxWords <= 0 || words <= opts.maxWords) {
    return { spoken: clean, chat: opts.alsoChat ? clean : null, policy: "full", words };
  }
  if (opts.longMode === "truncate") {
    return { spoken: truncateToWords(clean, opts.maxWords), chat: clean, policy: "truncate", words };
  }
  const ask = opts.askText?.trim() || defaultAskText(opts.lang, opts.topic);
  return { spoken: ask, chat: clean, policy: "ask", words };
}
