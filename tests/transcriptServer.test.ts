import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { isDirectLocalRequest, serve } from "../src/server.ts";
import { TranscriptLog } from "../src/transcriptLog.ts";
import { cmdTranscript } from "../src/commands/transcript.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

const TOKEN = "transcript-secret";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function transcriptEvent(speaker: string, text: string): unknown {
  return {
    event: "transcript.data",
    data: {
      data: {
        participant: { name: speaker },
        words: [{ text, start_timestamp: { absolute: "2026-10-06T16:46:18.000Z" } }],
      },
    },
  };
}

/** Raw HTTP/1.1 GET so tests control the Host and forwarding headers exactly. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      const lines = [`GET ${path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "Connection: close", "", ""];
      sock.write(lines.join("\r\n"));
    });
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("end", () => resolve(Number(buf.split(" ")[1])));
    sock.on("error", reject);
  });
}

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

describe("GET /transcript long-poll", () => {
  let tmp: string;
  let tf: string;
  let log: TranscriptLog;
  let server: ReturnType<typeof serve>;
  let base: string;
  const get = (q: string, headers: Record<string, string> = { "X-Samograph-Transcript-Token": TOKEN }) =>
    fetch(`${base}/transcript${q}`, { headers });
  const getJson = async (q: string): Promise<Json> => (await get(q)).json();

  beforeEach(() => {
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
    log = new TranscriptLog(tf);
    server = serve(0, tf, { webhookToken: "wh", transcriptToken: TOKEN, transcriptLog: log });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterEach(() => {
    server.stop(true);
    cleanupTmpDir(tmp);
  });

  it("numbers webhook lines and mirrors the file (seq, ts, speaker, text, offset)", async () => {
    await fetch(`${base}/webhook?token=wh`, { method: "POST", body: JSON.stringify(transcriptEvent("Alice", "hello")) });
    await fetch(`${base}/webhook?token=wh`, { method: "POST", body: JSON.stringify(transcriptEvent("Bob", "hi")) });
    const j = await getJson("?since=0");
    expect(j.lines.map((l: { seq: number }) => l.seq)).toEqual([1, 2]);
    expect(j.lines[0].speaker).toBe("Alice");
    expect(j.lines[0].text).toBe("hello");
    expect(j.lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(j.next).toBe(2);
    expect(j.offset).toBe(Buffer.byteLength(readFileSync(tf)));
    expect(j.lines.map((l: { line: string }) => l.line + "\n").join("")).toBe(readFileSync(tf, "utf-8"));
  });

  it("reopens persisted lines with stable cursors and UTF-8 byte offsets", async () => {
    const first = "[2026-10-06 16:46:18] Alice: already read";
    const unread = "[2026-10-06 16:46:19] Боб: ещё не прочитано 🌍";
    log.append(first);
    log.append(unread);
    server.stop(true);
    log = new TranscriptLog(tf);
    server = serve(0, tf, { webhookToken: "wh", transcriptToken: TOKEN, transcriptLog: log });
    base = `http://127.0.0.1:${server.port}`;

    const start = await getJson("?since=0&limit=1");
    expect(start.lines.map((l: { line: string }) => l.line)).toEqual([first]);
    expect(start.next).toBe(1);
    expect(start.offset).toBe(Buffer.byteLength(first + "\n"));
    const resumed = await getJson("?since=1");
    expect(resumed.lines.map((l: { line: string }) => l.line)).toEqual([unread]);
    expect(resumed.next).toBe(2);
    expect(resumed.offset).toBe(Buffer.byteLength(first + "\n" + unread + "\n"));
    expect(resumed.reset).toBe(false);
    log.append("new line");
    expect(log.since(2).lines.map(l => l.line)).toEqual(["new line"]);
    expect(log.since(3).offset).toBe(readFileSync(tf).length);
    expect(new TranscriptLog(tf).since(0)).toEqual(log.since(0));
  });

  it("seals an incomplete persisted line before appending a new logical line", () => {
    const prefix = Buffer.from("complete\nБоб: 🌍");
    writeFileSync(tf, prefix.subarray(0, prefix.length - 2));
    const reopened = new TranscriptLog(tf);
    expect(reopened.since(0).lines.map(l => l.line)).toEqual(["complete"]);
    expect(reopened.since(1).offset).toBe(Buffer.byteLength("complete\n"));
    // Complete the interrupted UTF-8 character, then append an unrelated line.
    appendFileSync(tf, prefix.subarray(prefix.length - 2));
    const completed = new TranscriptLog(tf);
    completed.append("watchdog warning");
    expect(completed.since(1).lines.map(l => l.line)).toEqual(["Боб: 🌍", "watchdog warning"]);
    expect(completed.since(3).offset).toBe(readFileSync(tf).length);
    expect(new TranscriptLog(tf).since(0)).toEqual(completed.since(0));
  });

  it("continues persisting new speech after detected file truncation", () => {
    log.append("old first");
    log.append("old second");
    writeFileSync(tf, "");
    log.append("new");
    const page = log.since(2);
    expect(page.reset).toBe(true);
    expect(page.lines.map(l => l.line)).toEqual(["new"]);
    expect(page.offset).toBe(4);
  });

  it("does not reread the complete transcript on each append", () => {
    log.append("x".repeat(100_000));
    const read = spyOn(fs, "readFileSync");
    const ranges = spyOn(fs, "readSync");
    try {
      log.append("next");
      expect(read).not.toHaveBeenCalled();
      expect(ranges.mock.calls.reduce((sum, call) => sum + Number((call as unknown[])[3]), 0)).toBeLessThan(512);
      expect(log.since(1).lines.map(l => l.line)).toEqual(["next"]);
    } finally { read.mockRestore(); ranges.mockRestore(); }
  });

  it("rehydrates equal-size and larger replacement files", () => {
    log.append("old");
    writeFileSync(tf + ".new", "new\n");
    fs.renameSync(tf + ".new", tf);
    expect(log.since(0).lines.map(l => l.line)).toEqual(["new"]);
    writeFileSync(tf, "replacement longer\n");
    log.append("latest");
    expect(log.since(0).lines.map(l => l.line)).toEqual(["replacement longer", "latest"]);
    expect(log.since(0).offset).toBe(readFileSync(tf).length);
  });

  it("recovers when the file disappears between stat and read", () => {
    log.append("old");
    appendFileSync(tf, "external\n");
    const read = spyOn(fs, "statSync").mockImplementationOnce(() => {
      fs.unlinkSync(tf);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    try { expect(() => log.since(0)).not.toThrow(); } finally { read.mockRestore(); }
    log.append("new");
    expect(log.since(0).lines.map(l => l.line)).toEqual(["new"]);
  });

  it("resyncs durable bytes when another writer races with append", () => {
    const original = fs.appendFileSync;
    const append = spyOn(fs, "appendFileSync").mockImplementation((path, data, options) => {
      original(path, "racing external\n");
      original(path, data, options);
    });
    try { log.append("own line"); } finally { append.mockRestore(); }
    expect(log.since(0).lines.map(l => l.line)).toEqual(["racing external", "own line"]);
    expect(log.since(2).offset).toBe(readFileSync(tf).length);
  });

  it("streams external writes to existing subscriptions", async () => {
    const lines: string[] = [];
    const stop = log.subscribe(e => lines.push(e.line), 0);
    try {
      appendFileSync(tf, "external stream line\n");
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(lines).toEqual(["external stream line"]);
    } finally { stop(); }
  });

  it("includes external writes before a later log append with accurate cursors", () => {
    log.append("one");
    appendFileSync(tf, "external 🌍\n");
    log.append("three");
    expect(log.since(1).lines.map(l => l.line)).toEqual(["external 🌍", "three"]);
    expect(log.since(3).offset).toBe(readFileSync(tf).length);
    expect(new TranscriptLog(tf).since(0)).toEqual(log.since(0));
  });

  it("does not report ended before paginated unread speech is consumed", () => {
    log.append("one");
    log.append("two");
    appendFileSync(tf, "[2026-10-06 18:46:30] SAMOGRAPH_CALL_ENDED\n");
    expect(log.since(0, 1).ended).toBe(false);
    expect(log.since(1, 1).ended).toBe(false);
    expect(log.since(2, 1).ended).toBe(true);
    expect(log.since(3).ended).toBe(true);
  });

  it("wakes a long poll for a line written outside the log", async () => {
    setTimeout(() => appendFileSync(tf, "external\n"), 50);
    const page = await log.wait(0, 1000);
    expect(page.lines.map(l => l.line)).toEqual(["external"]);
  });

  it("returns as soon as a new line arrives", async () => {
    setTimeout(() => log.append("[2026-10-06 16:46:18] Alice: late"), 150);
    const t0 = Date.now();
    const j = await getJson("?since=0&wait=10");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(j.lines.map((l: { text: string }) => l.text)).toEqual(["late"]);
    expect(j.next).toBe(1);
  });

  it("times out empty and keeps the cursor", async () => {
    log.append("[2026-10-06 16:46:18] Alice: one");
    const t0 = Date.now();
    const j = await getJson("?since=1&wait=0.4");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(j.lines).toEqual([]);
    expect(j.next).toBe(1);
  });

  it("serves multiple concurrent clients, each from its own since", async () => {
    log.append("[2026-10-06 16:46:18] Alice: one");
    const a = get("?since=0&wait=5");
    const b = get("?since=1&wait=5");
    const c = get("?since=1&wait=5");
    setTimeout(() => log.append("[2026-10-06 16:46:19] Bob: two"), 100);
    const [ja, jb, jc]: Json[] = await Promise.all([a, b, c].map(async (p) => (await p).json()));
    expect(ja.lines.map((l: { seq: number }) => l.seq)).toEqual([1]);
    expect(jb.lines.map((l: { seq: number }) => l.seq)).toEqual([2]);
    expect(jc.lines.map((l: { seq: number }) => l.seq)).toEqual([2]);
  });

  it("since ahead of the log (server restarted) resets to the start", async () => {
    log.append("[2026-10-06 16:46:18] Alice: one");
    const j = await getJson("?since=50");
    expect(j.reset).toBe(true);
    expect(j.lines.length).toBe(1);
  });

  it("requires the transcript token (fail closed)", async () => {
    expect((await get("?since=0", {})).status).toBe(403);
    expect((await get("?since=0", { "X-Samograph-Transcript-Token": "wrong" })).status).toBe(403);
    const open = serve(0, tf, { webhookToken: "wh" });
    try {
      const r = await fetch(`http://127.0.0.1:${open.port}/transcript?since=0`, {
        headers: { "X-Samograph-Transcript-Token": "" },
      });
      expect(r.status).toBe(403);
    } finally {
      open.stop(true);
    }
  });

  it("rejects requests relayed through a tunnel, even with a valid token", async () => {
    const port = server.port!;
    const ok = { Host: `127.0.0.1:${port}`, "X-Samograph-Transcript-Token": TOKEN };
    expect(await rawGet(port, "/transcript?since=0", ok)).toBe(200);
    // Public tunnel Host header (ngrok/cloudflared pass the public host through).
    expect(await rawGet(port, "/transcript?since=0", { ...ok, Host: "abc123.ngrok-free.app" })).toBe(404);
    expect(await rawGet(port, "/transcript?since=0", { ...ok, Host: "x.trycloudflare.com" })).toBe(404);
    // Forwarding headers added by tunnels/proxies.
    expect(await rawGet(port, "/transcript?since=0", { ...ok, "X-Forwarded-For": "203.0.113.7" })).toBe(404);
    expect(await rawGet(port, "/transcript?since=0", { ...ok, "Cf-Connecting-Ip": "203.0.113.7" })).toBe(404);
    expect(await rawGet(port, "/transcript?since=0", { ...ok, Forwarded: "for=203.0.113.7" })).toBe(404);
    expect(await rawGet(port, "/transcript/stream?since=0", { ...ok, "X-Forwarded-Host": "abc.ngrok.app" })).toBe(404);
  });

  it("isDirectLocalRequest rejects a non-loopback peer", () => {
    const req = new Request("http://127.0.0.1:8080/transcript", { headers: { host: "127.0.0.1:8080" } });
    expect(isDirectLocalRequest(req, "127.0.0.1")).toBe(true);
    expect(isDirectLocalRequest(req, "::1")).toBe(true);
    expect(isDirectLocalRequest(req, "192.168.1.20")).toBe(false);
    expect(isDirectLocalRequest(req, null)).toBe(false);
  });

  it("/transcript/stream sends existing and new lines as SSE events with id = seq", async () => {
    log.append("[2026-10-06 16:46:18] Alice: one");
    const ctrl = new AbortController();
    const r = await fetch(`${base}/transcript/stream?since=0`, {
      headers: { "X-Samograph-Transcript-Token": TOKEN },
      signal: ctrl.signal,
    });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    setTimeout(() => log.append("[2026-10-06 16:46:19] Bob: two"), 100);
    while (!text.includes("id: 2")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    ctrl.abort();
    expect(text).toContain("id: 1\ndata: ");
    expect(text).toContain('"text":"two"');
  });
});

describe("transcript --since via the live server", () => {
  let tmp: string;
  let tf: string;
  let env: Record<string, string | undefined>;
  let log: TranscriptLog;
  let server: ReturnType<typeof serve>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
    log = new TranscriptLog(tf);
    server = serve(0, tf, { webhookToken: "wh", transcriptToken: TOKEN, transcriptLog: log });
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
    writeFileSync(process.env.SAMOGRAPH_STATE_FILE, JSON.stringify({
      transcript_file: tf,
      local_transcript_url: `http://127.0.0.1:${server.port}/transcript`,
      transcript_token: TOKEN,
    }));
  });
  afterEach(() => {
    server.stop(true);
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("--since 0 uses the server and returns an s: cursor; chaining returns only new lines", async () => {
    log.append("[2026-10-06 16:46:18] Alice: one");
    const first = await capture(() => cmdTranscript({ command: "transcript", transcript_since: "0", transcript_json: true }));
    const j1 = JSON.parse(first.out);
    expect(j1.lines).toEqual(["[2026-10-06 16:46:18] Alice: one"]);
    expect(j1.cursor).toBe(`s:1:${Buffer.byteLength(readFileSync(tf))}`);

    setTimeout(() => log.append("[2026-10-06 16:46:17] Bob: two"), 100);
    const second = await capture(() =>
      cmdTranscript({ command: "transcript", transcript_since: j1.cursor, transcript_wait: 5 }),
    );
    expect(second.out).toBe("[2026-10-06 16:46:17] Bob: two\n");
    expect(second.err).toContain("SAMOGRAPH-CURSOR: s:2:");
  });

  it("repolls empty pages and preserves the full cursor in reset warnings", async () => {
    let calls = 0;
    const result = await capture(() => cmdTranscript(
      { command: "transcript", transcript_since: "s:8:88", transcript_wait: 120, transcript_json: true },
      { fetchFn: async (url) => {
        const query = new URL(url).searchParams;
        expect(Number(query.get("wait"))).toBeLessThanOrEqual(60);
        expect(query.get("since")).toBe(calls === 0 ? "8" : "0");
        calls++;
        return Response.json(calls === 1
          ? { lines: [], next: 0, offset: 0, reset: true, ended: false }
          : { lines: [{ line: "new" }], next: 1, offset: 4, reset: false, ended: false });
      } },
    ));
    expect(calls).toBe(2);
    expect(JSON.parse(result.out)).toEqual({ lines: ["new"], cursor: "s:1:4", ended: false, reset: true });
    expect(result.err).toContain("cursor s:8:88 is not valid for the current transcript");
  });

  it("advances a limited sentinel-only server page without emitting the sentinel", async () => {
    log.append("speech");
    const offset = log.since(1).offset;
    log.append("[2026-10-06 18:46:30] SAMOGRAPH_CALL_ENDED");
    const result = await capture(() => cmdTranscript({ command: "transcript", transcript_since: `s:1:${offset}`, transcript_limit: 1, transcript_json: true }));
    expect(JSON.parse(result.out)).toEqual({ lines: [], cursor: `s:2:${readFileSync(tf).length}`, ended: true, reset: false });
  });

  it("warns before falling back when the live server rejects a token", async () => {
    log.append("speech");
    const result = await capture(() => cmdTranscript(
      { command: "transcript", transcript_since: "0", transcript_json: true },
      { fetchFn: (async () => new Response("not found", { status: 404 })) },
    ));
    expect(JSON.parse(result.out).lines).toEqual(["speech"]);
    expect(result.err).toContain("SAMOGRAPH-WARNING: transcript server returned HTTP 404");
  });

  it("falls back to the transcript file when the server is gone (after leave)", async () => {
    log.append("[2026-10-06 16:46:18] Alice: one");
    const j1 = JSON.parse((await capture(() =>
      cmdTranscript({ command: "transcript", transcript_since: "0", transcript_json: true }),
    )).out);
    // leave: one more line, sentinel, server stopped.
    log.append("[2026-10-06 16:46:19] Bob: bye");
    appendFileSync(tf, "[2026-10-06 18:46:30] SAMOGRAPH_CALL_ENDED\n");
    server.stop(true);

    const r = await capture(() =>
      cmdTranscript({ command: "transcript", transcript_since: j1.cursor, transcript_json: true }),
    );
    const j2 = JSON.parse(r.out);
    expect(j2.lines).toEqual(["[2026-10-06 16:46:19] Bob: bye"]);
    expect(j2.ended).toBe(true);
    expect(j2.cursor).toMatch(/^b:\d+$/);
  });

  it("reports an externally written end sentinel while the server is still alive", async () => {
    log.append("speech");
    const first = JSON.parse((await capture(() => cmdTranscript({ command: "transcript", transcript_since: "0", transcript_json: true }))).out);
    appendFileSync(tf, "[2026-10-06 18:46:30] SAMOGRAPH_CALL_ENDED\n");
    const next = JSON.parse((await capture(() => cmdTranscript({ command: "transcript", transcript_since: first.cursor, transcript_json: true }))).out);
    expect(next.lines).toEqual([]);
    expect(next.ended).toBe(true);
    const again = JSON.parse((await capture(() => cmdTranscript({ command: "transcript", transcript_since: next.cursor, transcript_json: true }))).out);
    expect(again.ended).toBe(true);
  });

  it("b: cursors always read the file, even with a server running", async () => {
    log.append("[2026-10-06 16:46:18] Alice: one");
    const r = await capture(() => cmdTranscript({ command: "transcript", transcript_since: "b:0" }));
    expect(r.out).toBe("[2026-10-06 16:46:18] Alice: one\n");
    expect(r.err).toMatch(/SAMOGRAPH-CURSOR: b:\d+/);
  });
});
