/**
 * Plain-text transcript render tests (Story 3 — downloadable transcript).
 *
 * The download endpoint must emit the CLI-identical framing
 *     [YYYY-MM-DD HH:MM:SS] Speaker: utterance
 * one line per utterance, byte-identical to the CLI writer (SPEC §5.4). These
 * pure tests pin the exact bytes with no DB and no server.
 */
import { describe, it, expect } from "bun:test";
import { renderTranscriptLine, renderTranscriptText } from "./index.ts";

describe("renderTranscriptLine — CLI-identical framing (§5.4, Story 3)", () => {
  it("renders `[YYYY-MM-DD HH:MM:SS] Speaker: text` from a canonical ts", () => {
    expect(
      renderTranscriptLine({ ts: "2026-06-29 10:00:00", speaker: "Alice", text: "hello world" }),
    ).toBe("[2026-06-29 10:00:00] Alice: hello world");
  });

  it("converts an ISO `ts` (as the DB read emits) to the canonical space form", () => {
    // ws-hub's row mapper emits `new Date(ts).toISOString()` — must collapse to
    // the CLI's `YYYY-MM-DD HH:MM:SS` (drop the `T`, the millis, and the `Z`).
    expect(
      renderTranscriptLine({ ts: "2026-01-01T00:00:01.000Z", speaker: "Bob", text: "hi there" }),
    ).toBe("[2026-01-01 00:00:01] Bob: hi there");
  });

  it("defaults a null/blank speaker to `?` exactly like the CLI normalizer", () => {
    expect(
      renderTranscriptLine({ ts: "2026-01-01T00:00:03.000Z", speaker: null, text: "no speaker" }),
    ).toBe("[2026-01-01 00:00:03] ?: no speaker");
    expect(
      renderTranscriptLine({ ts: "2026-01-01 00:00:04", speaker: "   ", text: "blank speaker" }),
    ).toBe("[2026-01-01 00:00:04] ?: blank speaker");
  });
});

describe("renderTranscriptText — full downloadable body", () => {
  it("joins lines one-per-line with a trailing newline (CLI writes line + \\n)", () => {
    const body = renderTranscriptText([
      { ts: "2026-01-01T00:00:01.000Z", speaker: "Alice", text: "hello world" },
      { ts: "2026-01-01T00:00:02.000Z", speaker: "Bob", text: "hi there" },
      { ts: "2026-01-01T00:00:03.000Z", speaker: null, text: "no speaker line" },
    ]);
    expect(body).toBe(
      "[2026-01-01 00:00:01] Alice: hello world\n" +
        "[2026-01-01 00:00:02] Bob: hi there\n" +
        "[2026-01-01 00:00:03] ?: no speaker line\n",
    );
  });

  it("renders an empty transcript as the empty string (no stray newline)", () => {
    expect(renderTranscriptText([])).toBe("");
  });
});
