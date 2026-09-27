/**
 * #307 prototype 1 — `samograph watch --remote` via PLAIN POLLING.
 *
 * The CLI polls `GET /calls/:id/transcript?since_seq=N` on the hosted site
 * every N seconds (default 2 s). These are the hermetic (no DB, no network)
 * client tests against an in-memory fake of that endpoint:
 *
 *   (a) lines after `since_seq` arrive exactly once and in order;
 *   (b) disconnect / 5xx / process restart mid-stream → resume from the cursor:
 *       no duplicates, no loss;
 *   (c) 401/403 stop immediately with a clear message (no retry loop);
 *   (d) the token is sent ONLY in `Authorization: Bearer`, never in a URL,
 *       and never appears in any log or stdout output;
 *   plus backoff-with-jitter on 5xx/network errors and `Retry-After` on 429.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  pollRemoteTranscript,
  runRemoteWatch,
  resolveRemoteToken,
  computeBackoffMs,
  RemoteAuthError,
  REMOTE_TOKEN_ENV,
  DEFAULT_REMOTE_INTERVAL_MS,
} from "../src/remoteWatch.ts";
import { parseArgs } from "../src/cli.ts";
import { SENTINEL_RE } from "../src/transcript.ts";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";

// Obviously-fake test credential; never a real token.
const TOKEN = "fake-share-token-for-tests-0000";
const BASE = "https://site.test";
const CALL = "11111111-1111-4111-8111-111111111111";

interface Line {
  seq: number;
  ts: string;
  speaker: string | null;
  text: string;
}

function line(seq: number): Line {
  return { seq, ts: `2026-01-01 00:00:${String(seq).padStart(2, "0")}`, speaker: `S${seq}`, text: `t${seq}` };
}
const rendered = (seq: number) => `[2026-01-01 00:00:${String(seq).padStart(2, "0")}] S${seq}: t${seq}`;

type Scripted =
  | { kind: "ok" }
  | { kind: "status"; status: number; headers?: Record<string, string>; body?: string }
  | { kind: "throw"; message: string };

/** In-memory fake of the hosted `/calls/:id/transcript` endpoint. */
class FakeSite {
  lines: Line[] = [];
  ended = false;
  script: Scripted[] = [];
  requests: { url: string; headers: Headers }[] = [];
  /** Hook run before answering each request (to append lines mid-stream). */
  onRequest?: (n: number) => void;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    this.requests.push({ url, headers });
    this.onRequest?.(this.requests.length);
    const step = this.script.shift() ?? { kind: "ok" };
    if (step.kind === "throw") throw new Error(step.message);
    if (step.kind === "status") {
      return new Response(step.body ?? null, { status: step.status, headers: step.headers });
    }
    const u = new URL(url);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 403 });
    const since = Number(u.searchParams.get("since_seq") ?? "0");
    const out = this.lines.filter((l) => l.seq > since);
    return Response.json({
      call_id: CALL,
      since_seq: since,
      status: this.ended ? "ENDED" : "IN_CALL",
      ended: this.ended,
      lines: out,
    });
  };
}

const noSleep = async (_ms: number) => {};

describe("pollRemoteTranscript (#307 polling client)", () => {
  let site: FakeSite;
  let logs: string[];
  const log = (m: string) => logs.push(m);

  beforeEach(() => {
    site = new FakeSite();
    logs = [];
  });

  it("(a) emits only lines after since_seq, exactly once, in order, across polls", async () => {
    site.lines = [1, 2, 3, 4].map(line);
    site.onRequest = (n) => {
      if (n === 2) site.lines.push(line(5), line(6));
      if (n === 3) site.lines.push(line(7));
      if (n === 4) site.ended = true;
    };
    const got: number[] = [];
    const res = await pollRemoteTranscript({
      baseUrl: BASE,
      callId: CALL,
      token: TOKEN,
      sinceSeq: 2,
      fetch: site.fetch,
      sleep: noSleep,
      log,
      onLine: (_l, seq) => {
        got.push(seq);
      },
    });
    expect(got).toEqual([3, 4, 5, 6, 7]);
    expect(res).toEqual({ lastSeq: 7, reason: "ended" });
    // Every poll carries the latest cursor.
    expect(site.requests.map((r) => new URL(r.url).searchParams.get("since_seq"))).toEqual(["2", "4", "6", "7"]);
  });

  it("(a) drops a replayed/out-of-order line with seq <= last (defence in depth)", async () => {
    let first = true;
    const f = async (input: string | URL | Request, init?: RequestInit) => {
      if (first) {
        first = false;
        return Response.json({ call_id: CALL, since_seq: 0, status: "IN_CALL", ended: false, lines: [line(1), line(2)] });
      }
      // A misbehaving server replays 2 and sends 1 again alongside 3.
      void input;
      void init;
      return Response.json({ call_id: CALL, since_seq: 2, status: "ENDED", ended: true, lines: [line(2), line(1), line(3)] });
    };
    const got: number[] = [];
    await pollRemoteTranscript({ baseUrl: BASE, callId: CALL, token: TOKEN, fetch: f, sleep: noSleep, log, onLine: (_l, s) => void got.push(s) });
    expect(got).toEqual([1, 2, 3]);
  });

  it("renders lines in the CLI `[timestamp] Speaker: text` format", async () => {
    site.lines = [line(1), { seq: 2, ts: "2026-01-01 00:00:02", speaker: null, text: "no speaker" }];
    site.ended = true;
    const out: string[] = [];
    await pollRemoteTranscript({ baseUrl: BASE, callId: CALL, token: TOKEN, fetch: site.fetch, sleep: noSleep, log, onLine: (l) => void out.push(l) });
    expect(out).toEqual([rendered(1), "[2026-01-01 00:00:02] ?: no speaker"]);
  });

  it("(b) network error + 5xx mid-stream → backoff with jitter, then resume from the cursor: no dupes, no loss", async () => {
    site.lines = [line(1), line(2)];
    site.script = [
      { kind: "ok" },
      { kind: "throw", message: "ECONNRESET" },
      { kind: "status", status: 503 },
      { kind: "status", status: 502 },
      { kind: "ok" },
      { kind: "ok" },
    ];
    site.onRequest = (n) => {
      if (n === 3) site.lines.push(line(3)); // arrives while we are "down"
      if (n === 5) site.lines.push(line(4));
      if (n === 6) site.ended = true;
    };
    const sleeps: number[] = [];
    const got: number[] = [];
    await pollRemoteTranscript({
      baseUrl: BASE,
      callId: CALL,
      token: TOKEN,
      fetch: site.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
      intervalMs: 2000,
      backoff: { baseMs: 1000, capMs: 30_000 },
      log,
      onLine: (_l, s) => void got.push(s),
    });
    expect(got).toEqual([1, 2, 3, 4]);
    // Cursor carried through the outage: the resume poll asks since_seq=2.
    const cursors = site.requests.map((r) => new URL(r.url).searchParams.get("since_seq"));
    expect(cursors).toEqual(["0", "2", "2", "2", "2", "4"]);
    // interval, then backoff 1000*2^0, 2^1, 2^2 with jitter 0.5 → 750, 1500, 3000; then intervals.
    expect(sleeps).toEqual([2000, 750, 1500, 3000, 2000]);
  });

  it("computeBackoffMs: exponential, capped, jitter stays within [d/2, d]", () => {
    expect(computeBackoffMs(0, () => 0, 1000, 30_000)).toBe(500);
    expect(computeBackoffMs(0, () => 0.999999, 1000, 30_000)).toBeLessThanOrEqual(1000);
    expect(computeBackoffMs(3, () => 0, 1000, 30_000)).toBe(4000);
    expect(computeBackoffMs(20, () => 0, 1000, 30_000)).toBe(15_000);
    expect(computeBackoffMs(20, () => 1, 1000, 30_000)).toBe(30_000);
  });

  it("429 honors Retry-After (seconds) and then continues", async () => {
    site.lines = [line(1)];
    site.script = [{ kind: "status", status: 429, headers: { "Retry-After": "7" } }, { kind: "ok" }];
    site.onRequest = (n) => {
      if (n === 2) site.ended = true;
    };
    const sleeps: number[] = [];
    const got: number[] = [];
    await pollRemoteTranscript({
      baseUrl: BASE,
      callId: CALL,
      token: TOKEN,
      fetch: site.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      log,
      onLine: (_l, s) => void got.push(s),
    });
    expect(sleeps).toEqual([7000]);
    expect(got).toEqual([1]);
  });

  for (const status of [401, 403]) {
    it(`(c) ${status} → stops immediately with a clear message, no retries`, async () => {
      site.script = [{ kind: "status", status }];
      let err: unknown;
      try {
        await pollRemoteTranscript({ baseUrl: BASE, callId: CALL, token: TOKEN, fetch: site.fetch, sleep: noSleep, log, onLine: () => {} });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RemoteAuthError);
      expect((err as Error).message).toBe(
        `access denied (HTTP ${status}) for call ${CALL}: the token is invalid, expired, revoked, or not for this call`,
      );
      expect(site.requests.length).toBe(1);
    });
  }

  it("(d) token only in the Authorization header — never in a URL or any log line, even on errors", async () => {
    site.lines = [line(1)];
    site.script = [
      { kind: "throw", message: `connect failed for Bearer ${TOKEN}` },
      { kind: "status", status: 500, body: `echo ${TOKEN}` },
      { kind: "status", status: 429, headers: { "Retry-After": "1" } },
      { kind: "ok" },
    ];
    site.onRequest = (n) => {
      if (n === 4) site.ended = true;
    };
    const out: string[] = [];
    await pollRemoteTranscript({ baseUrl: BASE, callId: CALL, token: TOKEN, fetch: site.fetch, sleep: noSleep, log, onLine: (l) => void out.push(l) });
    expect(site.requests.length).toBe(4);
    for (const r of site.requests) {
      expect(r.url).not.toContain(TOKEN);
      expect(new URL(r.url).searchParams.has("token")).toBe(false);
      expect(r.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const m of [...logs, ...out]) expect(m).not.toContain(TOKEN);
  });

  it("stops when the abort signal fires (returns reason aborted)", async () => {
    const ac = new AbortController();
    site.onRequest = (n) => {
      if (n === 3) ac.abort();
    };
    const res = await pollRemoteTranscript({ baseUrl: BASE, callId: CALL, token: TOKEN, fetch: site.fetch, sleep: noSleep, log, signal: ac.signal, onLine: () => {} });
    expect(res.reason).toBe("aborted");
  });

  it("uses a 2 s default interval", async () => {
    expect(DEFAULT_REMOTE_INTERVAL_MS).toBe(2000);
    site.onRequest = (n) => {
      if (n === 2) site.ended = true;
    };
    const sleeps: number[] = [];
    await pollRemoteTranscript({ baseUrl: BASE, callId: CALL, token: TOKEN, fetch: site.fetch, sleep: async (ms) => void sleeps.push(ms), log, onLine: () => {} });
    expect(sleeps).toEqual([2000]);
  });
});

describe("runRemoteWatch (file + stdout + persisted cursor)", () => {
  let tmp: string;
  let site: FakeSite;
  let stdout: string[];
  let logs: string[];
  beforeEach(() => {
    tmp = makeTmpDir();
    site = new FakeSite();
    stdout = [];
    logs = [];
  });
  afterEach(() => cleanupTmpDir(tmp));

  it("(b) process restart: resumes from the persisted cursor; the transcript file has every line exactly once", async () => {
    const tf = join(tmp, "transcript.txt");
    site.lines = [1, 2, 3].map(line);
    // First run: dies (abort) after receiving 1..3.
    const ac = new AbortController();
    site.onRequest = (n) => {
      if (n === 2) ac.abort();
    };
    await runRemoteWatch({
      baseUrl: BASE, callId: CALL, token: TOKEN, transcriptFile: tf,
      fetch: site.fetch, sleep: noSleep, signal: ac.signal,
      write: (s) => void stdout.push(s), log: (m) => void logs.push(m),
    });
    expect(existsSync(`${tf}.cursor`)).toBe(true);
    expect(JSON.parse(readFileSync(`${tf}.cursor`, "utf-8"))).toEqual({ call_id: CALL, since_seq: 3 });

    // Lines 4..5 land while the laptop is offline; then a fresh process resumes.
    site.lines.push(line(4), line(5));
    site.ended = true;
    site.onRequest = undefined;
    const before = site.requests.length;
    await runRemoteWatch({
      baseUrl: BASE, callId: CALL, token: TOKEN, transcriptFile: tf,
      fetch: site.fetch, sleep: noSleep,
      write: (s) => void stdout.push(s), log: (m) => void logs.push(m),
    });
    expect(new URL(site.requests[before]!.url).searchParams.get("since_seq")).toBe("3");

    const fileLines = readFileSync(tf, "utf-8").split("\n").filter(Boolean);
    expect(fileLines.slice(0, 5)).toEqual([1, 2, 3, 4, 5].map(rendered));
    expect(fileLines.length).toBe(6);
    expect(SENTINEL_RE.test(fileLines[5]!)).toBe(true);
    expect(stdout.join("")).toBe([1, 2, 3, 4, 5].map((s) => rendered(s) + "\n").join(""));
    for (const m of [...logs, ...stdout, readFileSync(tf, "utf-8"), readFileSync(`${tf}.cursor`, "utf-8")]) {
      expect(m).not.toContain(TOKEN);
    }
  });

  it("a cursor file for a DIFFERENT call is ignored (starts from 0)", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(`${tf}.cursor`, JSON.stringify({ call_id: "other-call", since_seq: 99 }));
    site.lines = [line(1)];
    site.ended = true;
    await runRemoteWatch({ baseUrl: BASE, callId: CALL, token: TOKEN, transcriptFile: tf, fetch: site.fetch, sleep: noSleep, write: () => {}, log: () => {} });
    expect(new URL(site.requests[0]!.url).searchParams.get("since_seq")).toBe("0");
  });
});

describe("resolveRemoteToken", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => cleanupTmpDir(tmp));

  it(`reads ${REMOTE_TOKEN_ENV} from the environment`, () => {
    expect(resolveRemoteToken({ env: { [REMOTE_TOKEN_ENV]: ` ${TOKEN} ` } })).toBe(TOKEN);
  });

  it("reads a token file (trimmed) and prefers it over the env var", () => {
    const f = join(tmp, "tok");
    writeFileSync(f, `${TOKEN}\n`);
    expect(resolveRemoteToken({ env: { [REMOTE_TOKEN_ENV]: "other" }, tokenFile: f })).toBe(TOKEN);
  });

  it("errors clearly (without echoing anything secret) when no token is configured", () => {
    expect(() => resolveRemoteToken({ env: {} })).toThrow(
      `no call token: set ${REMOTE_TOKEN_ENV} or pass --token-file FILE`,
    );
  });
});

describe("watch --remote argument parsing", () => {
  it("parses --remote/--call/--token-file/--interval/--transcript-file", () => {
    const a = parseArgs([
      "watch", "--remote", "https://samograph.samo.team", "--call", CALL,
      "--token-file", "/tmp/t", "--interval", "0.5", "--transcript-file", "/tmp/x.txt",
    ]);
    expect(a.remote).toBe("https://samograph.samo.team");
    expect(a.call_id).toBe(CALL);
    expect(a.token_file).toBe("/tmp/t");
    expect(a.interval_ms).toBe(500);
    expect(a.transcript_file).toBe("/tmp/x.txt");
  });

  it("requires --call with --remote", () => {
    expect(() => parseArgs(["watch", "--remote", "https://samograph.samo.team"])).toThrow("--call");
  });

  it("refuses plain http:// to a non-loopback host (the bearer token would travel in clear)", () => {
    expect(() => parseArgs(["watch", "--remote", "http://samograph.samo.team", "--call", CALL])).toThrow("https");
    expect(parseArgs(["watch", "--remote", "http://127.0.0.1:8788", "--call", CALL]).remote).toBe("http://127.0.0.1:8788");
    expect(parseArgs(["watch", "--remote", "http://localhost:8788", "--call", CALL]).remote).toBe("http://localhost:8788");
  });

  it("has no --token flag (a token on the command line leaks via ps / shell history)", () => {
    expect(() => parseArgs(["watch", "--remote", "https://x.test", "--call", CALL, "--token", TOKEN])).toThrow();
  });

  it("plain `watch` is unchanged (local file tail)", () => {
    const a = parseArgs(["watch"]);
    expect(a.remote ?? null).toBe(null);
  });
});
