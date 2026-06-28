import { describe, it, expect } from "bun:test";
import { normalizeTranscriptLine } from "./index.ts";
// Parity oracle: the existing CLI formatter. The shared normalizer MUST be
// byte-identical to it so the wire/disk transcript format never drifts
// (SPEC §5.4, §6.2 #1).
import { formatTranscriptLine } from "../../../src/transcript.ts";
// Fixtures come from the deterministic, network-free in-repo Recall fake
// (the §6.1 PR-gate Recall) so payload shapes match real `transcript.data`.
import { createRecallFake } from "../../test-fakes/recall/index.ts";

const SEED = "normalizer-seed-001";
const AT = "2026-01-01T00:01:30.000Z"; // matches the fake's deterministic default

type RawWord = { text?: string; start_timestamp?: { absolute?: string } };

/** Hand-build a `transcript.data` payload with full control over every field. */
function rawEvent(opts: {
  speaker?: string | null; // null => omit `participant` entirely
  words: RawWord[];
  isFinal?: boolean; // an `is_final` flag the normalizer must IGNORE
  event?: string;
}): unknown {
  const inner: Record<string, unknown> = { words: opts.words };
  if (opts.speaker !== null && opts.speaker !== undefined) {
    inner.participant = { name: opts.speaker };
  }
  if (opts.isFinal !== undefined) inner.is_final = opts.isFinal;
  return { event: opts.event ?? "transcript.data", data: { data: inner } };
}

/** A single utterance event: every word shares one absolute timestamp. */
function utterance(
  speaker: string,
  words: string[],
  at = AT,
  isFinal?: boolean,
): unknown {
  return rawEvent({
    speaker,
    words: words.map((text) => ({ text, start_timestamp: { absolute: at } })),
    isFinal,
  });
}

/** All permutations of a (small) array — used for the reordering property. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 1) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

describe("normalizeTranscriptLine — §6.2 #1 red cases (exact values)", () => {
  it("§6.2 #1 — empty words[] emits no line (null)", () => {
    const fake = createRecallFake({ seed: SEED });
    expect(normalizeTranscriptLine(fake.transcriptData({ speaker: "Alice", words: [] })))
      .toBeNull();
    // participant present, zero words → still null
    expect(normalizeTranscriptLine(utterance("Alice", []))).toBeNull();
  });

  it("§6.2 #1 — partial and final each emit their own exact line (is_final ignored)", () => {
    const partial = utterance("Alice", ["hello"], AT, false);
    const final = utterance("Alice", ["hello", "world"], AT, true);
    expect(normalizeTranscriptLine(partial)).toBe("[2026-01-01 00:01:30] Alice: hello");
    expect(normalizeTranscriptLine(final)).toBe("[2026-01-01 00:01:30] Alice: hello world");
  });

  it("§6.2 #1 — missing speaker → '?'", () => {
    // participant omitted entirely
    expect(
      normalizeTranscriptLine(
        rawEvent({
          speaker: null,
          words: [{ text: "hi", start_timestamp: { absolute: "2026-01-01T00:00:00.000Z" } }],
        }),
      ),
    ).toBe("[2026-01-01 00:00:00] ?: hi");
    // participant present but blank/whitespace name → sanitized to "" → "?"
    expect(normalizeTranscriptLine(utterance("   ", ["hi"], "2026-01-01T00:00:00.000Z")))
      .toBe("[2026-01-01 00:00:00] ?: hi");
  });

  it("§6.2 #1 — Unicode speaker and words preserved verbatim", () => {
    expect(
      normalizeTranscriptLine(utterance("Renée", ["café", "☕", "—", "日本語", "🙂"], AT)),
    ).toBe("[2026-01-01 00:01:30] Renée: café ☕ — 日本語 🙂");
  });

  it("§6.2 #1 — very long utterance formats exactly (no truncation)", () => {
    const words = Array.from({ length: 500 }, (_, i) => `w${i}`);
    const expected = `[2026-01-01 00:01:30] Alice: ${words.join(" ")}`;
    const line = normalizeTranscriptLine(utterance("Alice", words, AT));
    expect(line).toBe(expected);
    expect(line!.length).toBe(expected.length); // pin exact length too
  });

  it("§6.2 #1 — timestamp derives from words[0] only; later-word drift ignored", () => {
    const drift = rawEvent({
      speaker: "Bob",
      words: [
        { text: "one", start_timestamp: { absolute: "2026-01-01T00:00:01.000Z" } },
        { text: "two", start_timestamp: { absolute: "2026-01-01T00:00:09.999Z" } },
        { text: "three", start_timestamp: { absolute: "2026-01-01T23:59:59.123456Z" } },
      ],
    });
    expect(normalizeTranscriptLine(drift)).toBe("[2026-01-01 00:00:01] Bob: one two three");
  });

  it("§6.2 #1 — timestamp: ms truncated; missing/empty absolute → '[]'", () => {
    // milliseconds (and extra digits) sliced off at 19 chars
    expect(normalizeTranscriptLine(utterance("Eve", ["x"], "2025-12-31T23:59:59.999999Z")))
      .toBe("[2025-12-31 23:59:59] Eve: x");
    // word with no start_timestamp at all
    expect(normalizeTranscriptLine(rawEvent({ speaker: "Dan", words: [{ text: "hello" }] })))
      .toBe("[] Dan: hello");
    // start_timestamp present but absolute undefined
    expect(
      normalizeTranscriptLine(rawEvent({ speaker: "Eve", words: [{ text: "hi", start_timestamp: {} }] })),
    ).toBe("[] Eve: hi");
  });

  it("non-transcript / malformed payloads → null (never throws)", () => {
    expect(normalizeTranscriptLine({ event: "other.event", data: {} })).toBeNull();
    expect(normalizeTranscriptLine({ data: {} })).toBeNull(); // no event field
    expect(normalizeTranscriptLine({})).toBeNull();
    expect(normalizeTranscriptLine(null)).toBeNull();
    expect(normalizeTranscriptLine(undefined)).toBeNull();
    expect(normalizeTranscriptLine("not an object")).toBeNull();
    expect(normalizeTranscriptLine(42)).toBeNull();
  });

  it("collapses CR/LF + internal whitespace and trims edges (sanitize semantics)", () => {
    const payload = rawEvent({
      speaker: "  Alice\tSmith  ",
      words: [
        { text: " hello ", start_timestamp: { absolute: AT } },
        { text: "wor\r\nld", start_timestamp: { absolute: AT } },
        { text: "\t\t", start_timestamp: { absolute: AT } },
      ],
    });
    expect(normalizeTranscriptLine(payload)).toBe("[2026-01-01 00:01:30] Alice Smith: hello wor ld");
  });

  it("drives the deterministic Recall fake transcriptData() to an exact line", () => {
    const fake = createRecallFake({ seed: SEED });
    const payload = fake.transcriptData({ speaker: "Alice", words: ["hello", "world"], at: AT });
    expect(normalizeTranscriptLine(payload)).toBe("[2026-01-01 00:01:30] Alice: hello world");
  });
});

describe("normalizeTranscriptLine — byte-identical parity with CLI (§5.4)", () => {
  const fake = createRecallFake({ seed: SEED });
  const corpus: unknown[] = [
    fake.transcriptData({ speaker: "Alice", words: ["hello", "world"], at: AT }),
    fake.transcriptData({ speaker: "Renée", words: ["café", "☕", "日本語"], at: AT }),
    fake.transcriptData({ speaker: "Solo", words: ["yo"] }), // fake's default `at`
    fake.transcriptData({ speaker: "Empty", words: [] }), // → null
    utterance("Alice", ["hello"], AT, false),
    utterance("Alice", ["hello", "world"], AT, true),
    rawEvent({
      speaker: null,
      words: [{ text: "hi", start_timestamp: { absolute: "2026-01-01T00:00:00.000Z" } }],
    }),
    utterance("   ", ["hi"], "2026-01-01T00:00:00.000Z"),
    rawEvent({ speaker: "Dan", words: [{ text: "hello" }] }),
    rawEvent({ speaker: "Eve", words: [{ text: "hi", start_timestamp: {} }] }),
    rawEvent({
      speaker: "Bob",
      words: [
        { text: "one", start_timestamp: { absolute: "2026-01-01T00:00:01.000Z" } },
        { text: "two", start_timestamp: { absolute: "2026-01-01T00:00:09.999Z" } },
      ],
    }),
    rawEvent({
      speaker: "  Alice\tSmith  ",
      words: [
        { text: " hello ", start_timestamp: { absolute: AT } },
        { text: "wor\r\nld", start_timestamp: { absolute: AT } },
      ],
    }),
    { event: "other.event", data: {} },
    { data: {} },
    {},
    null,
    undefined,
    "garbage",
    42,
  ];

  it("produces output byte-identical to src/transcript.ts:formatTranscriptLine over the corpus", () => {
    for (const p of corpus) {
      expect(normalizeTranscriptLine(p)).toBe(formatTranscriptLine(p));
    }
  });
});

describe("normalizeTranscriptLine — property / idempotence (§6.2 #1)", () => {
  it("same input → same output (deterministic & pure: no input mutation, no global state)", () => {
    const build = () => utterance("Alice", ["alpha", "beta", "gamma"], AT);
    const expected = "[2026-01-01 00:01:30] Alice: alpha beta gamma";
    for (let i = 0; i < 1000; i += 1) {
      expect(normalizeTranscriptLine(build())).toBe(expected);
    }
    // re-normalizing the SAME object instance is stable and leaves it untouched
    const payload = build();
    const before = JSON.stringify(payload);
    const a = normalizeTranscriptLine(payload);
    const b = normalizeTranscriptLine(payload);
    expect(a).toBe(b);
    expect(a).toBe(expected);
    expect(JSON.stringify(payload)).toBe(before); // input not mutated
  });

  it("does not mutate the input words array — a deeply frozen payload still normalizes", () => {
    // If the normalizer tried to sort/splice in place, this throws on the frozen array.
    const words = Object.freeze([
      Object.freeze({ text: "gamma", start_timestamp: Object.freeze({ absolute: AT }) }),
      Object.freeze({ text: "alpha", start_timestamp: Object.freeze({ absolute: AT }) }),
    ]);
    const payload = Object.freeze({
      event: "transcript.data",
      data: Object.freeze({
        data: Object.freeze({ participant: Object.freeze({ name: "Alice" }), words }),
      }),
    });
    expect(normalizeTranscriptLine(payload)).toBe("[2026-01-01 00:01:30] Alice: gamma alpha");
  });

  it("idempotent across reorderings within one utterance: speaker, timestamp & word-multiset invariant", () => {
    const base = ["the", "quick", "brown", "fox"]; // one utterance → one shared ts
    const perms = permutations(base);
    expect(perms.length).toBe(24); // 4! — exhaustive coverage
    const sortedWords = [...base].sort().join("|");
    for (const perm of perms) {
      const line = normalizeTranscriptLine(utterance("Narrator", perm, AT));
      expect(line).not.toBeNull();
      // timestamp bracket invariant under reordering (single shared timestamp)
      expect(line!.slice(0, 21)).toBe("[2026-01-01 00:01:30]");
      const m = line!.match(/^\[2026-01-01 00:01:30\] Narrator: (.+)$/);
      expect(m).not.toBeNull();
      const body = m![1]!;
      // word multiset preserved — nothing dropped, duplicated, or invented
      expect(body.split(" ").sort().join("|")).toBe(sortedWords);
      // visible order tracks INPUT order (CLI parity: array order kept, NOT sorted)
      expect(body).toBe(perm.join(" "));
    }
  });
});
