/**
 * `samograph watch --remote <site> --call <id> --mode longpoll` — the CLI half
 * of #307 prototype 2/3. Pure (no DB): the site is a scripted fake `fetch`.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  watchRemoteLongPoll,
  longPollUrl,
  clientTimeoutMs,
  backoffDelayMs,
  type FetchLike,
} from "../src/remoteWatch.ts";
import { parseArgs } from "../src/cli.ts";

// Obviously-fake placeholder credential (never a real token).
const TOKEN = "test-share-token-not-real-0123456789";
const CALL = "11111111-2222-3333-4444-555555555555";

function linesBody(since: number, lines: Array<{ seq: number; text: string; speaker?: string | null; kind?: "chat" }>) {
  return Response.json({
    call_id: CALL,
    since_seq: since,
    next_seq: lines.length ? lines[lines.length - 1]!.seq : since,
    lines: lines.map((l) => ({
      seq: l.seq,
      ts: `2026-09-27 10:00:0${l.seq}`,
      speaker: l.speaker === undefined ? "Alice" : l.speaker,
      text: l.text,
      ...(l.kind ? { kind: l.kind } : {}),
    })),
  });
}

/** A scripted site: each call pops the next response (or throws it). */
function scripted(steps: Array<Response | Error | ((url: string) => Response)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (step === undefined) return new Response(null, { status: 403 }); // end the run
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(url) : step;
  };
  return { calls, fetchImpl };
}

describe("remote long-poll client helpers", () => {
  it("builds the cursor URL with since_seq + wait and never a token", () => {
    expect(longPollUrl("https://site.example/", CALL, 42, 25)).toBe(
      `https://site.example/calls/${CALL}/lines?since_seq=42&wait=25`,
    );
  });

  it("client timeout = wait + 10 s", () => {
    expect(clientTimeoutMs(25)).toBe(35_000);
    expect(clientTimeoutMs(50)).toBe(60_000);
  });

  it("backoff is exponential with full jitter and capped", () => {
    expect(backoffDelayMs(0, 500, 30_000, () => 0.999)).toBe(499);
    expect(backoffDelayMs(3, 500, 30_000, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(20, 500, 30_000, () => 0.999)).toBe(29_970);
    expect(backoffDelayMs(20, 500, 30_000, () => 0)).toBe(0);
  });
});

describe("watchRemoteLongPoll", () => {
  it("prints [ts] Speaker: text, appends to the file, and advances the cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samograph-rw-"));
    const file = join(dir, "t.txt");
    try {
      const { calls, fetchImpl } = scripted([
        linesBody(0, [
          { seq: 1, text: "hello" },
          { seq: 2, text: "hi in chat", speaker: "Bob", kind: "chat" },
        ]),
        linesBody(2, []),
        linesBody(2, [{ seq: 3, text: "no speaker", speaker: null }]),
      ]);
      const printed: string[] = [];
      const res = await watchRemoteLongPoll({
        baseUrl: "https://site.example",
        callId: CALL,
        token: TOKEN,
        waitS: 25,
        transcriptFile: file,
        fetch: fetchImpl,
        sleep: async () => {},
        log: () => {},
        onLine: (line) => void printed.push(line),
      });
      expect(printed).toEqual([
        "[2026-09-27 10:00:01] Alice: hello",
        "[2026-09-27 10:00:02] Bob (chat): hi in chat",
        "[2026-09-27 10:00:03] ?: no speaker",
      ]);
      expect(readFileSync(file, "utf-8")).toBe(printed.map((l) => l + "\n").join(""));
      expect(calls.map((c) => new URL(c.url).searchParams.get("since_seq"))).toEqual(["0", "2", "2", "3"]);
      expect(res.sinceSeq).toBe(3);
      expect(res.stopReason).toBe("unauthorized");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never re-emits a seq at or below the cursor (overlapping replay is deduped)", async () => {
    const { fetchImpl } = scripted([
      linesBody(0, [{ seq: 1, text: "a" }, { seq: 2, text: "b" }]),
      linesBody(2, [{ seq: 2, text: "b" }, { seq: 3, text: "c" }]),
    ]);
    const got: number[] = [];
    await watchRemoteLongPoll({
      baseUrl: "https://site.example", callId: CALL, token: TOKEN, transcriptFile: null,
      fetch: fetchImpl, sleep: async () => {}, log: () => {}, onLine: (_l, s) => void got.push(s),
    });
    expect(got).toEqual([1, 2, 3]);
  });

  it("sends the token ONLY as Authorization: Bearer, with a wait+10 s timeout signal", async () => {
    const { calls, fetchImpl } = scripted([linesBody(0, [])]);
    await watchRemoteLongPoll({
      baseUrl: "https://site.example", callId: CALL, token: TOKEN, waitS: 7, transcriptFile: null,
      fetch: fetchImpl, sleep: async () => {}, log: () => {},
    });
    const first = calls[0]!;
    expect(first.url).not.toContain(TOKEN);
    expect(new Headers(first.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(first.init.signal).toBeInstanceOf(AbortSignal);
    expect(new URL(first.url).searchParams.get("wait")).toBe("7");
  });

  it("backs off with jitter on 5xx and network errors, then resumes from the cursor", async () => {
    const { calls, fetchImpl } = scripted([
      linesBody(0, [{ seq: 1, text: "a" }]),
      new Response("bad gateway", { status: 502 }),
      new TypeError("fetch failed"),
      new Response(null, { status: 503 }),
      linesBody(1, [{ seq: 2, text: "b" }]),
    ]);
    const slept: number[] = [];
    const logs: string[] = [];
    const got: number[] = [];
    const res = await watchRemoteLongPoll({
      baseUrl: "https://site.example", callId: CALL, token: TOKEN, transcriptFile: null,
      fetch: fetchImpl, sleep: async (ms) => void slept.push(ms), random: () => 0.5,
      backoffBaseMs: 500, backoffMaxMs: 30_000,
      log: (m) => void logs.push(m), onLine: (_l, s) => void got.push(s),
    });
    expect(got).toEqual([1, 2]);
    expect(slept).toEqual([250, 500, 1000]); // attempt 0,1,2 at jitter 0.5
    expect(res.errors).toBe(3);
    // every retry resumed from cursor 1 — nothing lost, nothing repeated
    expect(calls.slice(1, 5).map((c) => new URL(c.url).searchParams.get("since_seq"))).toEqual(["1", "1", "1", "1"]);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("honours 429 Retry-After", async () => {
    const { fetchImpl } = scripted([
      new Response(null, { status: 429, headers: { "retry-after": "3" } }),
      linesBody(0, [{ seq: 1, text: "a" }]),
    ]);
    const slept: number[] = [];
    await watchRemoteLongPoll({
      baseUrl: "https://site.example", callId: CALL, token: TOKEN, transcriptFile: null,
      fetch: fetchImpl, sleep: async (ms) => void slept.push(ms), log: () => {},
    });
    expect(slept).toEqual([3000]);
  });

  for (const status of [401, 403]) {
    it(`stops with a clear message on ${status} (no retry, token not echoed)`, async () => {
      const { calls, fetchImpl } = scripted([new Response(null, { status })]);
      const logs: string[] = [];
      const res = await watchRemoteLongPoll({
        baseUrl: "https://site.example", callId: CALL, token: TOKEN, transcriptFile: null,
        fetch: fetchImpl, sleep: async () => {}, log: (m) => void logs.push(m),
      });
      expect(res.stopReason).toBe("unauthorized");
      expect(calls.length).toBe(1);
      expect(logs.join("\n")).toContain(`HTTP ${status}`);
      expect(logs.join("\n")).toContain("SAMOGRAPH_CALL_TOKEN");
      expect(logs.join("\n")).not.toContain(TOKEN);
    });
  }

  it("stops when aborted by the caller", async () => {
    const ac = new AbortController();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    setTimeout(() => ac.abort(), 30);
    const res = await watchRemoteLongPoll({
      baseUrl: "https://site.example", callId: CALL, token: TOKEN, transcriptFile: null,
      fetch: fetchImpl, signal: ac.signal, sleep: async () => {}, log: () => {},
    });
    expect(res.stopReason).toBe("aborted");
  });
});

describe("watch --remote argument parsing", () => {
  it("parses --remote, --call, --mode longpoll, --wait, --since", () => {
    const a = parseArgs(["watch", "--remote", "https://site.example", "--call", CALL, "--mode", "longpoll", "--wait", "30", "--since", "12"]);
    expect(a.remote).toBe("https://site.example");
    expect(a.call_id).toBe(CALL);
    expect(a.remote_mode).toBe("longpoll");
    expect(a.wait).toBe(30);
    expect(a.since_seq).toBe(12);
  });

  it("plain `watch` is unchanged (local tail)", () => {
    const a = parseArgs(["watch"]);
    expect(a.remote ?? null).toBeNull();
  });

  it("--remote requires --call; unknown modes and wait > 50 are rejected; no --token flag", () => {
    expect(() => parseArgs(["watch", "--remote", "https://s"])).toThrow(/--call/);
    expect(() => parseArgs(["watch", "--remote", "https://s", "--call", CALL, "--mode", "carrier-pigeon"])).toThrow(/--mode/);
    expect(() => parseArgs(["watch", "--remote", "https://s", "--call", CALL, "--wait", "51"])).toThrow(/--wait/);
    expect(() => parseArgs(["watch", "--remote", "https://s", "--call", CALL, "--token", TOKEN])).toThrow(/unrecognized/);
  });
});
