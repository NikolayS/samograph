import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTranscriptSince, waitTranscriptSince } from "../src/transcript.ts";
import { cmdTranscript } from "../src/commands/transcript.ts";
import { parseArgs } from "../src/cli.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (s: string) => { out.push(s); return true; };
  (process.stderr.write as unknown) = (s: string) => { err.push(s); return true; };
  try { await fn(); } finally {
    (process.stdout.write as unknown) = o;
    (process.stderr.write as unknown) = e;
  }
  return { out: out.join(""), err: err.join("") };
}

const L1 = "[2026-10-06 16:46:18] Alice: one\n";
const L2 = "[2026-10-06 16:46:17] Bob: two (logged out of timestamp order)\n";
const L3 = "[2026-10-06 16:46:20] Carol: три\n";

describe("readTranscriptSince", () => {
  let tmp: string;
  let tf: string;
  beforeEach(() => { tmp = makeTmpDir(); tf = join(tmp, "t.txt"); });
  afterEach(() => cleanupTmpDir(tmp));

  it("--since 0 returns all lines and a cursor at EOF", () => {
    writeFileSync(tf, L1 + L2);
    const r = readTranscriptSince(tf, 0);
    expect(r.lines).toEqual([L1.trimEnd(), L2.trimEnd()]);
    expect(r.cursor).toBe(Buffer.byteLength(L1 + L2));
    expect(r.reset).toBe(false);
    expect(r.ended).toBe(false);
  });

  it("returns only new lines, regardless of timestamp order", () => {
    writeFileSync(tf, L1);
    const a = readTranscriptSince(tf, 0);
    appendFileSync(tf, L2);
    const b = readTranscriptSince(tf, a.cursor);
    expect(b.lines).toEqual([L2.trimEnd()]);
  });

  it("chained cursors never repeat or skip lines (multibyte included)", () => {
    writeFileSync(tf, "");
    let c = 0;
    const seen: string[] = [];
    for (const l of [L1, L2, L3]) {
      appendFileSync(tf, l);
      const r = readTranscriptSince(tf, c);
      seen.push(...r.lines);
      c = r.cursor;
    }
    const again = readTranscriptSince(tf, c);
    expect(seen).toEqual([L1, L2, L3].map((l) => l.trimEnd()));
    expect(again.lines).toEqual([]);
    expect(again.cursor).toBe(c);
  });

  it("does not return a partial trailing line and keeps the cursor before it", () => {
    writeFileSync(tf, L1 + "[2026-10-06 16:46:19] Dan: half");
    const r = readTranscriptSince(tf, 0);
    expect(r.lines).toEqual([L1.trimEnd()]);
    expect(r.cursor).toBe(Buffer.byteLength(L1));
    appendFileSync(tf, " done\n");
    const r2 = readTranscriptSince(tf, r.cursor);
    expect(r2.lines).toEqual(["[2026-10-06 16:46:19] Dan: half done"]);
  });

  it("cursor past EOF (file replaced) resets to 0 with a warning", () => {
    writeFileSync(tf, L1);
    const r = readTranscriptSince(tf, 10_000);
    expect(r.reset).toBe(true);
    expect(r.warning).toContain("past end");
    expect(r.lines).toEqual([L1.trimEnd()]);
  });

  it("cursor not on a line boundary resets to 0", () => {
    writeFileSync(tf, L1 + L2);
    const r = readTranscriptSince(tf, 5);
    expect(r.reset).toBe(true);
    expect(r.lines.length).toBe(2);
  });

  it("missing file returns no lines and cursor 0", () => {
    const r = readTranscriptSince(join(tmp, "nope.txt"), 0);
    expect(r.missing).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.cursor).toBe(0);
  });

  it("stops at the call-ended sentinel and reports it on every later call", () => {
    writeFileSync(tf, L1 + "[2026-10-06 18:46:30] SAMOGRAPH_CALL_ENDED\n");
    const r = readTranscriptSince(tf, 0);
    expect(r.lines).toEqual([L1.trimEnd()]);
    expect(r.ended).toBe(true);
    const r2 = readTranscriptSince(tf, r.cursor);
    expect(r2.ended).toBe(true);
    expect(r2.lines).toEqual([]);
  });

  it("limit caps lines and the cursor resumes after the last returned line", () => {
    writeFileSync(tf, L1 + L2 + L3);
    const r = readTranscriptSince(tf, 0, 1);
    expect(r.lines).toEqual([L1.trimEnd()]);
    const r2 = readTranscriptSince(tf, r.cursor, 5);
    expect(r2.lines).toEqual([L2.trimEnd(), L3.trimEnd()]);
  });
});

describe("waitTranscriptSince", () => {
  let tmp: string;
  let tf: string;
  beforeEach(() => { tmp = makeTmpDir(); tf = join(tmp, "t.txt"); });
  afterEach(() => cleanupTmpDir(tmp));

  it("times out with no lines and the same cursor", async () => {
    writeFileSync(tf, L1);
    const c = Buffer.byteLength(L1);
    const t0 = Date.now();
    const r = await waitTranscriptSince(tf, c, { waitSeconds: 0.3, pollMs: 50 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.lines).toEqual([]);
    expect(r.cursor).toBe(c);
  });

  it("returns as soon as a new line is appended", async () => {
    writeFileSync(tf, L1);
    const c = Buffer.byteLength(L1);
    setTimeout(() => appendFileSync(tf, L2), 100);
    const t0 = Date.now();
    const r = await waitTranscriptSince(tf, c, { waitSeconds: 5, pollMs: 20 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.lines).toEqual([L2.trimEnd()]);
  });
});

describe("transcript --since CLI", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
  });
  afterEach(() => { restoreEnv(env); cleanupTmpDir(tmp); });

  it("parses --since, --wait (optional value) and --json", () => {
    const a = parseArgs(["transcript", "--since", "b:42", "--wait", "--json"]);
    expect(a.transcript_since).toBe("b:42");
    expect(a.transcript_wait).toBe(30);
    expect(a.transcript_json).toBe(true);
    expect(parseArgs(["transcript", "--since", "0", "--wait", "5"]).transcript_wait).toBe(5);
    expect(parseArgs(["transcript", "--since=0", "--wait=2.5"]).transcript_wait).toBe(2.5);
    expect(parseArgs(["transcript", "--since", "s:3:120"]).transcript_since).toBe("s:3:120");
    expect(parseArgs(["transcript", "--since", "17"]).transcript_since).toBe("17");
    expect(() => parseArgs(["transcript", "--since", "-1"])).toThrow();
    expect(() => parseArgs(["transcript", "--since", "s:3"])).toThrow();
    expect(() => parseArgs(["transcript", "--since", "x:1"])).toThrow();
    expect(() => parseArgs(["transcript", "--since", "0", "--cursor", "1"])).toThrow();
    expect(() => parseArgs(["transcript", "--wait", "5"])).toThrow();
  });

  it("uses the active call's transcript and prints the cursor on stderr", async () => {
    const tf = join(tmp, "live.txt");
    writeFileSync(tf, L1 + L2);
    writeFileSync(process.env.SAMOGRAPH_STATE_FILE!, JSON.stringify({ transcript_file: tf }));
    const { out, err } = await capture(() =>
      cmdTranscript({ command: "transcript", transcript_since: `b:${Buffer.byteLength(L1)}` }),
    );
    expect(out).toBe(L2);
    expect(err).toContain(`SAMOGRAPH-CURSOR: b:${Buffer.byteLength(L1 + L2)}`);
  });

  it("--json with --file returns {lines, cursor, ended, reset}", async () => {
    const tf = join(tmp, "archived.txt");
    writeFileSync(tf, L1);
    const { out } = await capture(() =>
      cmdTranscript({
        command: "transcript",
        transcript_file: tf,
        transcript_since: "99999",
        transcript_json: true,
      }),
    );
    const j = JSON.parse(out);
    expect(j).toEqual({ lines: [L1.trimEnd()], cursor: `b:${Buffer.byteLength(L1)}`, ended: false, reset: true });
  });

  it("missing file warns and returns cursor 0", async () => {
    const { out, err } = await capture(() =>
      cmdTranscript({ command: "transcript", transcript_file: join(tmp, "nope.txt"), transcript_since: "0" }),
    );
    expect(out).toBe("");
    expect(err).toContain("transcript not found");
    expect(err).toContain("SAMOGRAPH-CURSOR: b:0");
  });
});
