/**
 * `samograph watch --remote <site> --call <id> --mode ws` — the CLI client for
 * the tunnel-free delivery path (#307, prototype 3/3: WebSocket).
 *
 * These tests drive the REAL client against a small in-process FAKE ws-hub
 * (Bun.serve) so every wire behaviour is deterministic and needs no DB:
 *
 *   (a) since_seq=2 → only seq ≥ 3, exactly once, in order
 *   (d) a `{type:"gap"}` frame is filled via GET /calls/:id/transcript?since_seq=
 *   (e) 401/403 on the upgrade → stop with a clear message, no reconnect loop
 *   (f) the token is ONLY in the Authorization header — never in a URL or a log,
 *       and a reconnect resumes from since_seq
 *
 * The real-stack versions (real ws-hub + ingest + Postgres RLS) live in
 * `apps/ws-hub/remoteWatch.e2e.test.ts`.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import {
  remoteWatch,
  streamUrl,
  backoffDelay,
  type RemoteLine,
  type RemoteWatchEvent,
} from "../src/remoteWatch.ts";
import { runRemoteWatch } from "../src/commands/watch.ts";
import { parseArgs } from "../src/cli.ts";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";

const TOKEN = "fake-share-token.not-a-secret";
const CALL = "11111111-2222-3333-4444-555555555555";

function line(seq: number): RemoteLine {
  return { seq, ts: "2026-09-27 12:00:00", speaker: "Alice", text: `line ${seq}` };
}
const lineFrame = (seq: number) => JSON.stringify({ type: "line", ...line(seq), final: true });

interface Upgrade {
  url: string;
  authorization: string | null;
  sinceSeq: number | null;
}

/**
 * A scriptable fake ws-hub. `onOpen(ws, upgradeIndex)` decides what each
 * accepted socket receives; `deny` answers the upgrade with a bodyless status.
 */
function fakeHub(opts: {
  deny?: number;
  /** Extra headers on the deny response (e.g. Retry-After on a 429). */
  denyHeaders?: Record<string, string>;
  onOpen?: (ws: ServerWebSocket<Upgrade>, n: number, u: Upgrade) => void;
  transcript?: (sinceSeq: number) => RemoteLine[];
}) {
  const upgrades: Upgrade[] = [];
  const restRequests: Upgrade[] = [];
  const server: Server<Upgrade> = Bun.serve<Upgrade>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const u: Upgrade = {
        url: req.url,
        authorization: req.headers.get("authorization"),
        sinceSeq: url.searchParams.has("since_seq") ? Number(url.searchParams.get("since_seq")) : null,
      };
      if (url.pathname === `/calls/${CALL}/transcript`) {
        restRequests.push(u);
        const lines = opts.transcript ? opts.transcript(u.sinceSeq ?? 0) : [];
        return Response.json({ call_id: CALL, since_seq: u.sinceSeq, lines });
      }
      if (url.pathname === `/calls/${CALL}/stream`) {
        upgrades.push(u);
        if (opts.deny) return new Response(null, { status: opts.deny, headers: opts.denyHeaders });
        if (srv.upgrade(req, { data: u })) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        opts.onOpen?.(ws, upgrades.length - 1, ws.data);
      },
      message() {},
    },
  });
  return { server, upgrades, restRequests, base: `http://localhost:${server.port}` };
}

/** Collects rendered output + logs + events; resolves when `n` lines arrived. */
function collector() {
  const out: string[] = [];
  const seqs: number[] = [];
  const logs: string[] = [];
  const events: RemoteWatchEvent[] = [];
  let want = Infinity;
  let done: () => void = () => {};
  const reached = new Promise<void>((r) => (done = r));
  return {
    out,
    seqs,
    logs,
    events,
    onLine: (rendered: string, l: RemoteLine) => {
      out.push(rendered);
      seqs.push(l.seq);
      if (seqs.length >= want) done();
    },
    log: (m: string) => logs.push(m),
    onEvent: (e: RemoteWatchEvent) => events.push(e),
    waitFor(n: number, ms = 4000) {
      want = n;
      if (seqs.length >= n) done();
      return Promise.race([
        reached,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error(`only got ${seqs.join(",")}`)), ms)),
      ]);
    },
  };
}

const servers: Server<Upgrade>[] = [];
const aborts: AbortController[] = [];
afterEach(() => {
  for (const a of aborts.splice(0)) a.abort();
  for (const s of servers.splice(0)) s.stop(true);
});
function track<T extends { server: Server<Upgrade> }>(h: T): T {
  servers.push(h.server);
  return h;
}
function ctl() {
  const a = new AbortController();
  aborts.push(a);
  return a;
}

describe("remoteWatch url + backoff (pure)", () => {
  it("builds a ws:// / wss:// stream URL with ONLY since_seq in the query", () => {
    expect(streamUrl("http://h:8788", CALL, 2)).toBe(`ws://h:8788/calls/${CALL}/stream?since_seq=2`);
    expect(streamUrl("https://site.example/", CALL, 0)).toBe(`wss://site.example/calls/${CALL}/stream?since_seq=0`);
  });

  it("exponential backoff with jitter, capped", () => {
    // random=1 → full delay; random=0 → half (equal jitter)
    expect(backoffDelay(0, 500, 30_000, () => 1)).toBe(500);
    expect(backoffDelay(3, 500, 30_000, () => 1)).toBe(4000);
    expect(backoffDelay(3, 500, 30_000, () => 0)).toBe(2000);
    expect(backoffDelay(20, 500, 30_000, () => 1)).toBe(30_000);
  });
});

describe("remoteWatch against a fake ws-hub", () => {
  it("(a) since_seq=2 → receives only seq ≥ 3, exactly once, in order (drops seq ≤ last)", async () => {
    const hub = track(
      fakeHub({
        onOpen: (ws) => {
          // A misbehaving/boundary-replaying server: re-sends 1..2 and dupes 3.
          for (const s of [1, 2, 3, 3, 4, 5]) ws.send(lineFrame(s));
        },
      }),
    );
    const c = collector();
    const a = ctl();
    const run = remoteWatch({ site: hub.base, callId: CALL, token: TOKEN, sinceSeq: 2, signal: a.signal, ...c });
    await c.waitFor(3);
    a.abort();
    expect(await run).toEqual({ reason: "aborted" });
    expect(c.seqs).toEqual([3, 4, 5]);
    expect(c.out).toEqual([
      "[2026-09-27 12:00:00] Alice: line 3",
      "[2026-09-27 12:00:00] Alice: line 4",
      "[2026-09-27 12:00:00] Alice: line 5",
    ]);
    expect(hub.upgrades[0]!.sinceSeq).toBe(2);
  });

  it("(d) a gap frame is filled via REST GET /transcript?since_seq=<last>", async () => {
    const hub = track(
      fakeHub({
        onOpen: (ws) => {
          ws.send(lineFrame(1));
          ws.send(lineFrame(2));
          ws.send(JSON.stringify({ type: "gap", since_seq: 3, until_seq: 5 }));
          ws.send(lineFrame(6));
          ws.send(lineFrame(7));
        },
        transcript: (since) => [3, 4, 5, 6].filter((s) => s > since).map(line),
      }),
    );
    const c = collector();
    const a = ctl();
    const run = remoteWatch({ site: hub.base, callId: CALL, token: TOKEN, signal: a.signal, ...c });
    await c.waitFor(7);
    a.abort();
    await run;
    expect(c.seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(hub.restRequests.map((r) => r.sinceSeq)).toEqual([2]);
    expect(hub.restRequests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.events.filter((e) => e.type === "gap-fill")).toEqual([{ type: "gap-fill", fromSeq: 2, count: 4 }]);
  });

  it("(d') a seq hole without a gap frame is also filled via REST", async () => {
    const hub = track(
      fakeHub({
        onOpen: (ws) => {
          ws.send(lineFrame(1));
          ws.send(lineFrame(4)); // 2,3 never pushed (e.g. out-of-order after-commit fan-in)
        },
        transcript: (since) => [2, 3, 4].filter((s) => s > since).map(line),
      }),
    );
    const c = collector();
    const a = ctl();
    const run = remoteWatch({ site: hub.base, callId: CALL, token: TOKEN, signal: a.signal, ...c });
    await c.waitFor(4);
    a.abort();
    await run;
    expect(c.seqs).toEqual([1, 2, 3, 4]);
  });

  for (const status of [401, 403]) {
    it(`(e) a ${status} upgrade stops with a clear message and does not reconnect`, async () => {
      const hub = track(fakeHub({ deny: status }));
      const c = collector();
      const res = await remoteWatch({ site: hub.base, callId: CALL, token: TOKEN, backoffBaseMs: 10, ...c });
      expect(res).toEqual({ reason: "unauthorized", status });
      expect(c.seqs).toEqual([]);
      expect(c.logs.join("\n")).toContain(`not authorized for call ${CALL} (HTTP ${status})`);
      // one WS attempt + one plain-HTTP probe to learn the status; no retry loop
      expect(hub.upgrades.length).toBe(2);
    });
  }

  it("(f) the token goes only in the Authorization header, never in a URL or a log", async () => {
    const hub = track(
      fakeHub({
        onOpen: (ws, n) => {
          ws.send(lineFrame(n + 1));
          if (n === 0) setTimeout(() => ws.close(1011, "drop"), 10);
        },
        transcript: () => [],
      }),
    );
    const c = collector();
    const a = ctl();
    const run = remoteWatch({
      site: hub.base, callId: CALL, token: TOKEN, signal: a.signal, backoffBaseMs: 10, random: () => 0, ...c,
    });
    await c.waitFor(2);
    a.abort();
    await run;
    // the reconnect resumes from the cursor (since_seq=1), not from 0
    expect(hub.upgrades.map((u) => u.sinceSeq)).toEqual([0, 1]);
    expect(c.seqs).toEqual([1, 2]);
    for (const u of hub.upgrades) {
      expect(u.url).not.toContain(TOKEN);
      expect(new URL(u.url).searchParams.has("token")).toBe(false);
      expect(u.authorization).toBe(`Bearer ${TOKEN}`);
    }
    // it did log the connect URL and the reconnect — just never the token
    expect(c.logs.filter((m) => m.startsWith("connected ")).length).toBe(2);
    expect(c.logs.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(c.events)).not.toContain(TOKEN);
  });
});

describe("remoteWatch robustness (review fixes)", () => {
  it("abort while the upgrade is still pending resolves promptly (no hang)", async () => {
    // Accepts TCP, never answers the upgrade (a hung proxy/upstream).
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    try {
      const a = ctl();
      const run = remoteWatch({ site: `http://127.0.0.1:${tcp.port}`, callId: CALL, token: TOKEN, signal: a.signal, onLine: () => {} });
      await Bun.sleep(100);
      a.abort();
      const r = await Promise.race([run, Bun.sleep(500).then(() => "hang" as const)]);
      expect(r).toEqual({ reason: "aborted" });
    } finally {
      tcp.stop(true);
    }
  });

  it("a stalled upgrade times out after staleMs and reconnects", async () => {
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    try {
      const c = collector();
      const a = ctl();
      const run = remoteWatch({
        site: `http://127.0.0.1:${tcp.port}`, callId: CALL, token: TOKEN, signal: a.signal,
        staleMs: 150, backoffBaseMs: 10, random: () => 1, ...c,
      });
      const deadline = Date.now() + 2000;
      while (!c.events.some((e) => e.type === "reconnect") && Date.now() < deadline) await Bun.sleep(10);
      a.abort();
      await run;
      expect(c.events.find((e) => e.type === "reconnect")).toEqual({ type: "reconnect", attempt: 1, delayMs: 10 });
    } finally {
      tcp.stop(true);
    }
  });

  it("a socket that opens and closes at once backs off exponentially (no reconnect storm)", async () => {
    const hub = track(fakeHub({ onOpen: (ws) => ws.close(1011, "stream open failed") }));
    const c = collector();
    const a = ctl();
    const run = remoteWatch({ site: hub.base, callId: CALL, token: TOKEN, signal: a.signal, backoffBaseMs: 10, random: () => 1, ...c });
    const deadline = Date.now() + 3000;
    while (c.events.filter((e) => e.type === "reconnect").length < 4 && Date.now() < deadline) await Bun.sleep(5);
    a.abort();
    await run;
    const delays = c.events.flatMap((e) => (e.type === "reconnect" ? [e.delayMs] : [])).slice(0, 4);
    expect(delays).toEqual([10, 20, 40, 80]);
  });

  it("a huge Retry-After is capped at one hour (Bun turns delays > 2^31-1 ms into 1 ms)", async () => {
    const hub = track(fakeHub({ deny: 429, denyHeaders: { "retry-after": "3000000" } }));
    const c = collector();
    const a = ctl();
    const run = remoteWatch({ site: hub.base, callId: CALL, token: TOKEN, signal: a.signal, backoffBaseMs: 10, random: () => 1, ...c });
    const deadline = Date.now() + 2000;
    while (!c.events.some((e) => e.type === "reconnect") && Date.now() < deadline) await Bun.sleep(5);
    a.abort();
    await run;
    expect(c.events.find((e) => e.type === "reconnect")).toEqual({ type: "reconnect", attempt: 1, delayMs: 3_600_000 });
  });

  it("a terminal status fetches the tail once more, so lines committed just before the end are kept", async () => {
    const hub = track(
      fakeHub({
        onOpen: (ws) => {
          ws.send(lineFrame(1));
          ws.send(JSON.stringify({ type: "status", status: "ENDED" }));
        },
        transcript: (since) => [1, 2].filter((s) => s > since).map(line),
      }),
    );
    const c = collector();
    const res = await remoteWatch({ site: hub.base, callId: CALL, token: TOKEN, ...c });
    expect(res).toEqual({ reason: "ended", status: "ENDED" });
    expect(c.seqs).toEqual([1, 2]);
    expect(hub.restRequests.map((r) => r.sinceSeq)).toEqual([1]);
  });
});

describe("samograph watch --remote (CLI wiring)", () => {
  it("parses --remote/--call/--mode/--since-seq/--out", () => {
    const a = parseArgs(["watch", "--remote", "http://h:1", "--call", CALL, "--mode", "ws", "--since-seq", "4", "--out", "/tmp/x.txt"]);
    expect(a.remote).toBe("http://h:1");
    expect(a.call_id).toBe(CALL);
    expect(a.mode).toBe("ws");
    expect(a.since_seq).toBe(4);
    expect(a.out).toBe("/tmp/x.txt");
  });

  it("refuses a cleartext http:// site unless it is loopback (the bearer token would travel unencrypted)", () => {
    expect(() => parseArgs(["watch", "--remote", "http://samograph.example", "--call", CALL])).toThrow(/https/);
    expect(() => parseArgs(["watch", "--remote", "ws://10.0.0.5:8788", "--call", CALL])).toThrow(/https/);
    for (const ok of ["https://samograph.example", "http://localhost:8788", "http://127.0.0.1:8788", "http://[::1]:8788"]) {
      expect(parseArgs(["watch", "--remote", ok, "--call", CALL]).remote).toBe(ok);
    }
  });

  it("rejects --remote without --call, a non-ws --mode, and a missing token", async () => {
    expect(() => parseArgs(["watch", "--remote", "http://h:1"])).toThrow(/--call/);
    expect(() => parseArgs(["watch", "--remote", "http://h:1", "--call", CALL, "--mode", "poll"])).toThrow(/--mode/);
    await expect(
      runRemoteWatch({ command: "watch", remote: "http://h:1", call_id: CALL, mode: "ws" }, { env: {} }),
    ).rejects.toThrow(/SAMOGRAPH_SHARE_TOKEN/);
  });

  it("appends `[ts] Speaker: text` lines to the transcript file + a resume cursor, and prints them", async () => {
    const dir = makeTmpDir();
    try {
      const hub = track(fakeHub({ onOpen: (ws) => [1, 2, 3].forEach((s) => ws.send(lineFrame(s))) }));
      const out = join(dir, "remote.txt");
      const printed: string[] = [];
      const a = ctl();
      const run = runRemoteWatch(
        { command: "watch", remote: hub.base, call_id: CALL, mode: "ws", out },
        { env: { SAMOGRAPH_SHARE_TOKEN: TOKEN }, signal: a.signal, print: (s) => printed.push(s), log: () => {} },
      );
      const deadline = Date.now() + 4000;
      while (printed.length < 3 && Date.now() < deadline) await Bun.sleep(5);
      a.abort();
      await run;
      const expected = [1, 2, 3].map((s) => `[2026-09-27 12:00:00] Alice: line ${s}`);
      expect(printed).toEqual(expected);
      expect(readFileSync(out, "utf-8")).toBe(expected.join("\n") + "\n");
      expect(readFileSync(`${out}.seq`, "utf-8").trim()).toBe("3");
      // meeting content is private to the user, like the rest of ~/.samograph
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(`${out}.seq`).mode & 0o777).toBe(0o600);

      // a restart resumes from the cursor file (since_seq=3), not from 0
      const a2 = ctl();
      const run2 = runRemoteWatch(
        { command: "watch", remote: hub.base, call_id: CALL, mode: "ws", out },
        { env: { SAMOGRAPH_SHARE_TOKEN: TOKEN }, signal: a2.signal, print: () => {}, log: () => {} },
      );
      const d2 = Date.now() + 4000;
      while (hub.upgrades.length < 2 && Date.now() < d2) await Bun.sleep(5);
      a2.abort();
      await run2;
      expect(hub.upgrades[1]!.sinceSeq).toBe(3);
      expect(readFileSync(out, "utf-8")).toBe(expected.join("\n") + "\n");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
