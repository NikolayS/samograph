/**
 * Long-poll transcript delivery — `GET /calls/:id/lines?since_seq=N&wait=S`
 * (issue #307, prototype 2/3). DB-backed against the CI ephemeral Postgres
 * (real migrations, real RLS, real share tokens); skips when DATABASE_URL is unset.
 *
 * Red/green acceptance (exact values):
 *   (a) a held request returns within 300 ms of a new line being committed
 *       (woken from the SAME post-commit fan-in point the WS hub uses);
 *   (b) a request with nothing new returns `lines: []` after `wait`;
 *   (c) exactly-once, in-order delivery across a reconnect (the CLI client
 *       against the real handler, with injected network failures);
 *   (d) a token for call A cannot read call B — a bodyless 403, identical to
 *       "not found";
 *   (e) the token never appears in a URL or in logs (a `?token=` URL is refused).
 *   BURST: 200 lines injected as fast as possible → all 200, in order, no dupes.
 *   LONG IDLE (SAMOGRAPH_SLOW_TESTS=1): 120 s of silence over a REAL Bun.serve,
 *       then 1 line → it arrives with zero client errors (the held request
 *       survives Bun's idleTimeout).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { mintShareToken } from "../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import { Hub } from "./hub.ts";
import { createFanIn } from "./fanIn.ts";
import {
  LineWaiters,
  createLongPollHandler,
  LONGPOLL_MAX_WAIT_S,
  LONGPOLL_REQUESTS_PER_WINDOW,
  type LongPollResponseBody,
} from "./longpoll.ts";
import { RequestRateCaps } from "./caps.ts";
import { startWsHubServer } from "./server.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { watchRemoteLongPoll, type FetchLike } from "../../src/remoteWatch.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;
const SLOW = HAVE_DB && process.env.SAMOGRAPH_SLOW_TESTS === "1";

const KEY: SigningKey = { kid: "lp1", secret: "ws-longpoll-test-secret-cccccccccccccccc" };
const keyring: Keyring = { current: KEY };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

d("long-poll /calls/:id/lines (#307 option 2)", () => {
  let sql: ReturnType<typeof connect>;
  const user = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID();
  const callB = randomUUID();
  const callC = randomUUID(); // reconnect test
  const callBurst = randomUUID();
  const callIdle = randomUUID();
  let tokenA = "";
  let tokenB = "";
  let tokenC = "";
  let tokenBurst = "";
  let tokenIdle = "";

  const authDeps: StreamAuthDeps = {
    keyring,
    lookupSession: async () => null,
    lookupCallTenant: async (id) => {
      try {
        const r = await sql`SELECT tenant_id FROM calls WHERE id = ${id}`;
        return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
      } catch {
        return null;
      }
    },
  };

  const hub = new Hub();
  const waiters = new LineWaiters();
  let fanIn: ReturnType<typeof createFanIn>;
  const seqs = new Map<string, number>();

  /** Commit one line (privileged insert) then deliver its signal post-commit. */
  async function say(callId: string, text: string): Promise<number> {
    const seq = (seqs.get(callId) ?? 0) + 1;
    seqs.set(callId, seq);
    await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text)
      VALUES (${callId}, ${seq}, '2026-09-27T10:00:00Z'::timestamptz + (${seq} * interval '1 second'), 'Alice', ${text})`;
    await fanIn.deliver({ k: "line", call_id: callId, seq });
    return seq;
  }

  function linesReq(
    callId: string,
    opts: { token?: string; since?: number; wait?: number; tokenInUrl?: boolean; signal?: AbortSignal } = {},
  ): Request {
    const u = new URL(`http://ws-hub.local/calls/${callId}/lines`);
    if (opts.since !== undefined) u.searchParams.set("since_seq", String(opts.since));
    if (opts.wait !== undefined) u.searchParams.set("wait", String(opts.wait));
    if (opts.tokenInUrl && opts.token) u.searchParams.set("token", opts.token);
    const headers: Record<string, string> = {};
    if (opts.token && !opts.tokenInUrl) headers.authorization = `Bearer ${opts.token}`;
    return new Request(u.toString(), { headers, signal: opts.signal });
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    fanIn = createFanIn({
      sql,
      hub,
      lookupCallTenant: authDeps.lookupCallTenant,
      onLine: (callId: string) => waiters.notify(callId),
    });
    await sql`INSERT INTO users (id, email) VALUES
      (${user}, ${`${user}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${user}), (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/lpa', 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://meet.google.com/lpb', 'IN_CALL'),
      (${callC}, ${tenantA}, 'https://meet.google.com/lpc', 'IN_CALL'),
      (${callBurst}, ${tenantA}, 'https://meet.google.com/lpd', 'IN_CALL'),
      (${callIdle}, ${tenantA}, 'https://meet.google.com/lpe', 'IN_CALL')`;
    const mint = async (callId: string) =>
      (await mintShareToken(sql, { callId, signingKey: KEY, ttlSeconds: 3600 })).token;
    tokenA = await mint(callA);
    tokenB = await mint(callB);
    tokenC = await mint(callC);
    tokenBurst = await mint(callBurst);
    tokenIdle = await mint(callIdle);
    await say(callA, "first");
    await say(callA, "second");
    await say(callB, "tenant B secret");
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${user}, ${userB})`; // CASCADE clears the rest
    await sql.close();
  });

  it("returns immediately with the exact tail when lines newer than the cursor exist", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const t0 = performance.now();
    const res = await handler(linesReq(callA, { token: tokenA, since: 0, wait: 25 }));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LongPollResponseBody;
    expect(body.call_id).toBe(callA);
    expect(body.since_seq).toBe(0);
    expect(body.next_seq).toBe(2);
    expect(body.lines.map((l) => [l.seq, l.speaker, l.text])).toEqual([
      [1, "Alice", "first"],
      [2, "Alice", "second"],
    ]);
  });

  it("(a) a held request returns within 300 ms of a new line being committed", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const since = seqs.get(callA)!;
    const pending = handler(linesReq(callA, { token: tokenA, since, wait: 10 }));
    let resolvedAt = 0;
    void pending.then(() => (resolvedAt = performance.now()));
    await sleep(150);
    expect(resolvedAt).toBe(0); // still held: nothing newer than the cursor yet
    expect(waiters.size(callA)).toBe(1);
    const seq = await say(callA, "wake up"); // commit + post-commit fan-in
    const committedAt = performance.now();
    const res = await pending;
    const latency = (resolvedAt || performance.now()) - committedAt;
    expect(latency).toBeLessThan(300);
    const body = (await res.json()) as LongPollResponseBody;
    expect(body.lines.map((l) => [l.seq, l.text])).toEqual([[seq, "wake up"]]);
    expect(body.next_seq).toBe(seq);
    expect(waiters.size(callA)).toBe(0); // the waiter is released
  });

  it("(b) a request with nothing new returns lines: [] after `wait`", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const since = seqs.get(callA)!;
    const t0 = performance.now();
    const res = await handler(linesReq(callA, { token: tokenA, since, wait: 1 }));
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(2000);
    expect((await res.json()) as LongPollResponseBody).toEqual({
      call_id: callA,
      since_seq: since,
      next_seq: since,
      lines: [],
    });
    expect(waiters.size(callA)).toBe(0);
  });

  it("caps `wait` at 50 s (Cloudflare 524 fires at 100 s)", () => {
    expect(LONGPOLL_MAX_WAIT_S).toBe(50);
  });

  it("a client that disconnects mid-hold releases its waiter", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const ac = new AbortController();
    const pending = handler(
      linesReq(callA, { token: tokenA, since: seqs.get(callA)!, wait: 10, signal: ac.signal }),
    );
    await sleep(100);
    expect(waiters.size(callA)).toBe(1);
    ac.abort();
    await pending;
    expect(waiters.size(callA)).toBe(0);
  });

  it("(d) a token for call A cannot read call B — bodyless 403, same as not-found", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const cross = await handler(linesReq(callB, { token: tokenA, since: 0, wait: 1 }));
    const missing = await handler(linesReq(randomUUID(), { token: tokenA, since: 0, wait: 1 }));
    const noCred = await handler(linesReq(callB, { since: 0, wait: 1 }));
    const garbage = await handler(linesReq(callB, { token: "not-a-token", since: 0, wait: 1 }));
    for (const res of [cross, missing, noCred, garbage]) {
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    }
    // …while B's own token reads B (the denial is the binding, not a broken gate).
    const own = await handler(linesReq(callB, { token: tokenB, since: 0, wait: 1 }));
    expect(own.status).toBe(200);
    expect(((await own.json()) as LongPollResponseBody).lines.map((l) => l.text)).toEqual([
      "tenant B secret",
    ]);
  });

  it("(e) a token in the URL is refused (400, bodyless) and nothing is logged", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const logged: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of ["log", "error", "warn", "info"] as const) {
      console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    }
    try {
      const inUrl = await handler(linesReq(callA, { token: tokenA, tokenInUrl: true, since: 0, wait: 1 }));
      expect(inUrl.status).toBe(400);
      expect(await inUrl.text()).toBe("");
      const denied = await handler(linesReq(callB, { token: tokenA, since: 0, wait: 1 }));
      expect(denied.status).toBe(403);
      const ok = await handler(linesReq(callA, { token: tokenA, since: 0, wait: 1 }));
      expect(ok.status).toBe(200);
    } finally {
      Object.assign(console, orig);
    }
    expect(logged.join("\n")).not.toContain(tokenA);
  });

  it("(c) exactly-once, in-order delivery across reconnects (CLI client ↔ real handler)", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const dir = mkdtempSync(join(tmpdir(), "samograph-lp-"));
    const file = join(dir, "remote.txt");
    try {
      await say(callC, "c1");
      await say(callC, "c2");
      await say(callC, "c3");
      let n = 0;
      const urls: string[] = [];
      const logs: string[] = [];
      // Route the client to the in-process handler; inject a hard network
      // failure on request #2 and a mid-hold disconnect on request #4, with lines
      // landing WHILE the client is disconnected each time.
      const fetchImpl: FetchLike = async (url, init) => {
        n += 1;
        urls.push(url);
        if (n === 2) {
          await say(callC, "c4");
          await say(callC, "c5");
          throw new TypeError("fetch failed (simulated network drop)");
        }
        if (n === 4) {
          const ac = new AbortController();
          const held = handler(new Request(url, { headers: init.headers, signal: ac.signal }));
          await sleep(50);
          ac.abort(); // the laptop's Wi-Fi drops mid-hold
          await held;
          await say(callC, "c6");
          throw new TypeError("socket hang up (simulated)");
        }
        return handler(new Request(url, { headers: init.headers, signal: init.signal ?? undefined }));
      };
      const got: number[] = [];
      const stop = new AbortController();
      const run = watchRemoteLongPoll({
        baseUrl: "http://ws-hub.local",
        callId: callC,
        token: tokenC,
        sinceSeq: 0,
        waitS: 2,
        transcriptFile: file,
        fetch: fetchImpl,
        signal: stop.signal,
        sleep: async () => {},
        log: (m) => void logs.push(m),
        onLine: (_line, seq) => {
          got.push(seq);
          if (seq === 10) stop.abort();
        },
      });
      // Lines arriving live after the reconnects.
      await sleep(300);
      for (const t of ["c7", "c8", "c9", "c10"]) {
        await say(callC, t);
        await sleep(20);
      }
      const result = await run;
      expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(result.sinceSeq).toBe(10);
      expect(result.errors).toBe(2);
      expect(readFileSync(file, "utf-8")).toBe(
        Array.from({ length: 10 }, (_, i) => `[2026-09-27 10:00:${String(i + 1).padStart(2, "0")}] Alice: c${i + 1}\n`).join(""),
      );
      for (const u of urls) expect(u).not.toContain(tokenC);
      expect(logs.join("\n")).not.toContain(tokenC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("BURST: 200 lines as fast as possible → all 200, in seq order, no duplicates", async () => {
    const handler = createLongPollHandler({ sql, authDeps, waiters });
    const got: number[] = [];
    const stop = new AbortController();
    let lastAt = 0;
    let requests = 0;
    const run = watchRemoteLongPoll({
      baseUrl: "http://ws-hub.local",
      callId: callBurst,
      token: tokenBurst,
      sinceSeq: 0,
      waitS: 25,
      transcriptFile: null,
      fetch: async (url, init) => {
        requests += 1;
        return handler(new Request(url, { headers: init.headers, signal: init.signal ?? undefined }));
      },
      signal: stop.signal,
      sleep: async () => {},
      log: () => {},
      onLine: (_l, seq) => {
        got.push(seq);
        if (seq === 200) {
          lastAt = performance.now();
          stop.abort();
        }
      },
    });
    await sleep(100);
    const firstAt = performance.now();
    for (let i = 1; i <= 200; i++) await say(callBurst, `burst ${i}`);
    await run;
    expect(got).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    console.log(
      `[burst] 200 lines: first inject → last line ${(lastAt - firstAt).toFixed(0)} ms, ${requests} requests`,
    );
  });

  it("the real server gives /lines its own budget: 150 req/min passes, the share REST cap is untouched", async () => {
    // Found by the burst measurement: sharing the 120/min /transcript cap made a
    // 200-line burst after a busy minute hit 429 (Retry-After ~40 s). Long-poll
    // responses are cursor-bounded (≤ 500 lines), so /lines gets its own cap.
    const srv = startWsHubServer({ sql, authDeps, hub, waiters: new LineWaiters(), port: 0 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 150; i++) {
        const r = await fetch(`${srv.url}/calls/${callA}/lines?since_seq=0&wait=0`, {
          headers: { authorization: `Bearer ${tokenA}` },
        });
        statuses.push(r.status);
        await r.body?.cancel();
      }
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      // …and the full-transcript REST read still has its full, separate budget.
      const t = await fetch(`${srv.url}/calls/${callA}/transcript?since_seq=0`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(t.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it("the /lines budget is still finite: over-cap → 429 with Retry-After", async () => {
    const handler = createLongPollHandler({
      sql,
      authDeps,
      waiters,
      restCaps: new RequestRateCaps({ perWindow: 3, windowMs: 60_000 }),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await handler(linesReq(callA, { token: tokenA, since: 0, wait: 0 }))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(LONGPOLL_REQUESTS_PER_WINDOW).toBe(600);
  });

  (SLOW ? it : it.skip)(
    "LONG IDLE: 120 s silence over a real Bun.serve, then 1 line arrives, zero errors",
    async () => {
      const idleWaiters = new LineWaiters();
      const idleFanIn = createFanIn({
        sql,
        hub,
        lookupCallTenant: authDeps.lookupCallTenant,
        onLine: (c: string) => idleWaiters.notify(c),
      });
      const srv = startWsHubServer({ sql, authDeps, hub, waiters: idleWaiters, port: 0 });
      const stop = new AbortController();
      let errors = 0;
      let requests = 0;
      const got: string[] = [];
      try {
        const run = watchRemoteLongPoll({
          baseUrl: srv.url,
          callId: callIdle,
          token: tokenIdle,
          sinceSeq: 0,
          waitS: 25,
          transcriptFile: null,
          signal: stop.signal,
          fetch: (url, init) => {
            requests += 1;
            return fetch(url, init);
          },
          log: (m) => {
            if (/error|retry/i.test(m)) errors += 1;
          },
          onLine: (line) => {
            got.push(line);
            stop.abort();
          },
        });
        await sleep(120_000);
        const t0 = performance.now();
        await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text)
          VALUES (${callIdle}, 1, '2026-09-27T10:00:00Z', 'Alice', 'after idle')`;
        await idleFanIn.deliver({ k: "line", call_id: callIdle, seq: 1 });
        const result = await run;
        console.log(
          `[idle] 120 s idle: ${requests} requests, ${result.errors} errors, ` +
            `line arrived ${(performance.now() - t0).toFixed(0)} ms after inject`,
        );
        expect(got).toEqual(["[2026-09-27 10:00:00] Alice: after idle"]);
        expect(result.errors).toBe(0);
        expect(errors).toBe(0);
        // 120 s / 25 s wait ⇒ ~5 held requests, never a tight loop.
        expect(requests).toBeLessThanOrEqual(7);
      } finally {
        await srv.stop();
      }
    },
    150_000,
  );
});
