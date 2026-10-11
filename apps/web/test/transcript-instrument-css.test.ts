import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");
const heading = "/* ===== Slice 3 — Transcript instrument (calls/[id], c/[token]) ===== */";

describe("Slice 3 transcript instrument CSS", () => {
  it("keeps the complete Slice 3 override section at the end of globals.css", () => {
    const section = css.slice(css.indexOf(heading));
    expect(css).toContain(heading);
    expect(section).toMatch(/\.samograph-instrument-lines\s*>\s*li\.samograph-transcript-row\s*\{/);
    expect(section).toMatch(
      /grid-template-columns\s*:\s*56px\s+19ch\s+fit-content\(22ch\)\s+minmax\(0\s*,\s*1fr\)/,
    );
    expect(section).toMatch(/\.samograph-line-time\s*\{[^}]*white-space\s*:\s*nowrap/s);
    expect(section).toMatch(/\.samograph-line-speaker\s*\{[^}]*display\s*:\s*inline-flex[^}]*min-width\s*:\s*8ch[^}]*overflow\s*:\s*hidden/s);
    expect(section).toMatch(/\.samograph-line-speaker-name\s*\{[^}]*flex\s*:\s*0\s+1\s+auto[^}]*min-width\s*:\s*0[^}]*overflow\s*:\s*hidden[^}]*text-overflow\s*:\s*ellipsis[^}]*white-space\s*:\s*nowrap/s);
    expect(section).toMatch(/\.samograph-line-speaker-marker\s*\{[^}]*flex\s*:\s*0\s+0\s+auto[^}]*white-space\s*:\s*pre/s);
    expect(section).toMatch(/\.samograph-transcript-row\s*>\s*\*\s*\{[^}]*min-width\s*:\s*0[^}]*overflow\s*:\s*hidden/s);
    expect(section).toMatch(/word-break\s*:\s*normal/);
    expect(section).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  it("does not constrain transcript or call-view classes to 32rem", () => {
    const offending = [...css.matchAll(/([^{}]*\.samograph-(?:transcript|percall|call-view|share-page)[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /max-width\s*:\s*(?:32rem|512px)/.test(body ?? ""));
    expect(offending).toEqual([]);
  });
});

describe("transcript row reflows to two rows below 1024px", () => {
  const section = css.slice(css.indexOf(heading));
  const mobile = section.slice(section.indexOf("@media (max-width: 63.99rem)"));

  it("has a max-width: 63.99rem block in the Slice 3 section", () => {
    expect(section).toContain("@media (max-width: 63.99rem)");
  });

  it("drops the four-column grid for a two-row meta/utterance grid", () => {
    expect(mobile).toMatch(
      /\.samograph-instrument-lines\s*>\s*li\.samograph-transcript-row\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)\s+auto\s*;[^}]*grid-template-areas\s*:\s*"speaker time"\s*"utterance utterance"\s*;/s,
    );
  });

  it("gives the utterance its own full-width row at 14px", () => {
    expect(mobile).toMatch(
      /\.samograph-line-utterance\s*\{[^}]*grid-area\s*:\s*utterance[^}]*font-size\s*:\s*var\(--text-base\)/s,
    );
  });

  it("places the speaker and the clock on the meta row and hides the gutter", () => {
    expect(mobile).toMatch(/\.samograph-line-speaker\s*\{[^}]*grid-area\s*:\s*speaker/s);
    expect(mobile).toMatch(/\.samograph-line-time\s*\{[^}]*grid-area\s*:\s*time/s);
    expect(mobile).toMatch(/\.samograph-percall\s+\.samograph-line-number\s*\{[^}]*display\s*:\s*none/s);
    expect(mobile).toMatch(/\.samograph-line-date\s*\{[^}]*display\s*:\s*none/s);
  });

  it("no longer shrinks the four-column grid at 40rem", () => {
    expect(section).not.toMatch(/42px\s+10ch\s+fit-content\(12ch\)/);
  });

  it("keeps the desktop four-column grid outside the mobile block", () => {
    const desktop = section.slice(0, section.indexOf("@media (max-width: 63.99rem)"));
    expect(desktop).toMatch(
      /grid-template-columns\s*:\s*56px\s+19ch\s+fit-content\(22ch\)\s+minmax\(0\s*,\s*1fr\)/,
    );
  });
});
