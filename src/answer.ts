/**
 * Matching a human reply (spoken or chat) to the options of `samograph ask`.
 * Pure functions, no I/O. English and Russian.
 */

const YES = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "agreed", "correct", "affirmative",
  "да", "ага", "угу", "давай", "давайте", "конечно", "согласен", "согласна", "верно", "ок", "окей",
]);
const NO = new Set(["no", "nope", "nah", "negative", "нет", "неа"]);

// Words that make a following single letter or number an explicit option pick.
const OPTION_WORDS = new Set([
  "option", "variant", "choice", "number",
  "вариант", "пункт", "номер",
]);
// Verbs/prepositions that make a following letter or number a pick ("go with B",
// "берём 2"), but not a function word ("go with a different plan").
const PICK_WORDS = new Set([
  "with", "take", "choose", "pick", "prefer", "vote", "answer",
  "за", "берем", "возьмем", "выбираю", "выбираем", "ответ",
]);

// Ordinal words (any grammatical form) -> 0-based index. Count anywhere in a reply.
const ORDINALS: [RegExp, number][] = [
  [/^(first|перв(ый|ая|ое|ого|ую|ой|ом|ые))$/, 0],
  [/^(second|втор(ой|ая|ое|ого|ую|ом|ые))$/, 1],
  [/^(third|трет(ий|ья|ье|ьего|ью|ьей|ьем|ьи))$/, 2],
  [/^(fourth|четверт(ый|ая|ое|ого|ую|ой|ом|ые))$/, 3],
  [/^(fifth|пят(ый|ая|ое|ого|ую|ой|ом|ые))$/, 4],
];
const LAST = /^(last|последн(ий|яя|ее|его|юю|ей|ем|ие))$/;

// Cardinal words: only in a short reply or right after an option word
// ("one" and "a" are too common in normal speech to count anywhere).
const CARDINALS: Record<string, number> = {
  one: 0, two: 1, three: 2, four: 3, five: 4,
  один: 0, одна: 0, одно: 0, два: 1, две: 1, три: 2, четыре: 3, пять: 4,
};

// Spoken names of Latin letters ("би" for B), and the Russian convention of
// labelling options А, Б, В, Г, Д (= 1st..5th).
const LETTER_NAMES: Record<string, string> = {
  эй: "a", би: "b", си: "c", ди: "d", bee: "b", see: "c", dee: "d",
};
const CYRILLIC_ORDER = ["а", "б", "в", "г", "д"];

// Short words that are also common function words ("a", "I", "one", Russian
// "а", "в", "с", "и"...): as an option pick they count only when they are
// the whole reply or follow an option word ("option A", "вариант В").
const FUNCTION_WORDS = new Set(["a", "i", "one", "а", "в", "с", "и", "о", "у", "к", "я"]);

/** Max tokens for a reply to count as "short" (just the answer, e.g. "B", "второй"). */
const SHORT_REPLY_TOKENS = 3;

export function normalizeReply(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Parse `--options "A|B|C"`: split on "|", trim, drop empties. */
export function parseOptions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split("|").map((s) => s.trim()).filter(Boolean);
}

export type OptionMatch =
  | { kind: "match"; index: number }
  | { kind: "ambiguous"; indexes: number[] }
  | { kind: "none" };

/**
 * Match a reply to one option. Recognizes: the option text itself; a number
 * ("2", "option 2", "two"); an ordinal ("second", "второй", "last");
 * a letter ("B", "вариант Б", "би"); and yes/no synonyms when the options are
 * yes/no ("да", "ok", "нет"). A reply that names two different options is
 * ambiguous, not a match.
 */
export function matchOption(reply: string, options: string[]): OptionMatch {
  const tokens = normalizeReply(reply);
  if (!tokens.length || !options.length) return { kind: "none" };
  const short = tokens.length <= SHORT_REPLY_TOKENS;
  const padded = ` ${tokens.join(" ")} `;
  const hits = new Set<number>();
  const add = (i: number) => {
    if (i >= 0 && i < options.length) hits.add(i);
  };
  // A single-letter/number token counts as a pick when it is the whole reply,
  // follows an option word, or (unless it is a function word) is in a short
  // reply or follows a pick word.
  const explicitAt = (j: number) => {
    const prev = j > 0 ? tokens[j - 1]! : "";
    if (OPTION_WORDS.has(prev) || tokens.length === 1) return true;
    if (FUNCTION_WORDS.has(tokens[j]!)) return false;
    return short || PICK_WORDS.has(prev);
  };

  const normOptions = options.map((o) => normalizeReply(o).join(" "));
  normOptions.forEach((o, i) => {
    if (!o) return;
    if (YES.has(o)) {
      if (tokens.some((t) => YES.has(t))) add(i);
      return;
    }
    if (NO.has(o)) {
      if (tokens.some((t) => NO.has(t))) add(i);
      return;
    }
    if (o.length === 1) {
      tokens.forEach((t, j) => {
        if ((t === o || LETTER_NAMES[t] === o) && explicitAt(j)) add(i);
      });
      return;
    }
    if (padded.includes(` ${o} `)) add(i);
  });

  tokens.forEach((t, j) => {
    for (const [re, idx] of ORDINALS) if (re.test(t)) add(idx);
    if (LAST.test(t)) add(options.length - 1);
    if (!explicitAt(j)) return;
    if (/^\d+$/.test(t)) add(Number(t) - 1);
    if (t in CARDINALS) add(CARDINALS[t]!);
    // "вариант Б" = 2nd option, unless an option is literally that letter.
    const cyr = CYRILLIC_ORDER.indexOf(t);
    if (cyr !== -1 && !normOptions.includes(t)) add(cyr);
  });

  const list = [...hits].sort((a, b) => a - b);
  if (list.length === 1) return { kind: "match", index: list[0]! };
  if (list.length > 1) return { kind: "ambiguous", indexes: list };
  return { kind: "none" };
}

/**
 * Resolve `--default` against the options: an option name (case-insensitive)
 * or a 1-based number. Without options, any non-empty default is accepted.
 * Returns null when the default does not name an option.
 */
export function resolveDefault(raw: string | null | undefined, options: string[]): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const v = raw.trim();
  if (!options.length) return v;
  const byName = options.find((o) => o.toLowerCase() === v.toLowerCase());
  if (byName !== undefined) return byName;
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 1 && n <= options.length) return options[n - 1]!;
  }
  return null;
}
