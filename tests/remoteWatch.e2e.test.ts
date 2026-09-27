/**
 * #307 prototype 1 (plain polling) — END-TO-END against a REAL ws-hub server
 * (`startWsHubServer`) on loopback, real Postgres migrations + RLS, real share
 * tokens minted with an in-test signing key (no real secrets). DB-gated: skips
 * cleanly when DATABASE_URL is unset.
 *
 *   (a) lines after `since_seq` arrive exactly once and in order;
 *   (b) server restart mid-stream → resume from the cursor: no dupes, no loss;
 *   (c) a token for call A cannot read call B — the SAME bodyless 403 as a call
 *       that doesn't exist — and the client stops with a clear message;
 *   (d) the token never appears in a request URL or in any log/stdout output;
 *   BURST: 200 lines injected as fast as possible → all 200, in order, no dupes;
 *   LONG IDLE (SAMOGRAPH_SLOW_TESTS=1): 120 s of silence, then 1 line → it
 *       arrives, zero errors/reconnects needed during the idle window.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../packages/shared/db/client.ts";
import { migrate } from "../packages/shared/db/migrate.ts";
import { mintShareToken } from "../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../packages/shared/tokens/signing.ts";
import type { StreamAuthDeps } from "../apps/ws-hub/stream.ts";
import { RequestRateCaps } from "../apps/ws-hub/caps.ts";
import { startWsHubServer, type WsHubServerHandle } from "../apps/ws-hub/server.ts";
import { pollRemoteTranscript, RemoteAuthError } from "../src/remoteWatch.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;
const SLOW = process.env.SAMOGRAPH_SLOW_TESTS === "1";

const KEY: SigningKey = { kid: "k307e", secret: "remote-watch-e2e-secret-dddddddddddddddd" };
const keyring: Keyring = { current: KEY };

d("watch --remote polling ↔ real ws-hub (#307)", () => {
  let sql: ReturnType<typeof connect>;
  const user = randomUUID();
  const tenant = randomUUID();
  const userB = randomUUID();
  const tenantB = randomUUID();

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

  function start(port = 0, restCaps?: RequestRateCaps): WsHubServerHandle {
    return startWsHubServer({
      sql,
      authDeps,
      port,
      hostname: "127.0.0.1",
      restCaps: restCaps ?? new RequestRateCaps({ perWindow: 100_000 }),
    });
  }

  async function newCall(t = tenant): Promise<{ callId: string; token: string }> {
    const callId = randomUUID();
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status)
      VALUES (${callId}, ${t}, 'https://meet.google.com/e2e', 'IN_CALL')`;
    const { token } = await mintShareToken(sql, { callId, signingKey: KEY, ttlSeconds: 3600 });
    return { callId, token };
  }

  async function say(callId: string, seq: number): Promise<void> {
    await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text)
      VALUES (${callId}, ${seq}, now(), ${`S${seq}`}, ${`line ${seq}`})`;
  }
  async function end(callId: string): Promise<void> {
    await sql`UPDATE calls SET status = 'ENDED' WHERE id = ${callId}`;
  }

  /** A fetch that records every URL + auth header the client sends. */
  function recordingFetch() {
    const seen: { url: string; auth: string | null }[] = [];
    const f = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return fetch(input, init);
    };
    return { f, seen };
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${user}, ${`${user}@e2e.test`}), (${userB}, ${`${userB}@e2e.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenant}, ${user}), (${tenantB}, ${userB})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${user}, ${userB})`;
    await sql.close();
  });

  it("(a) lines after since_seq arrive exactly once, in order; stops on ENDED", async () => {
    const hub = start();
    try {
      const { callId, token } = await newCall();
      for (let s = 1; s <= 5; s++) await say(callId, s);
      const got: number[] = [];
      const run = pollRemoteTranscript({
        baseUrl: hub.url, callId, token, sinceSeq: 2, intervalMs: 30, log: () => {},
        onLine: (_l, seq) => void got.push(seq),
      });
      await Bun.sleep(100);
      for (let s = 6; s <= 10; s++) await say(callId, s);
      await Bun.sleep(100);
      await say(callId, 11);
      await end(callId);
      const res = await run;
      expect(got).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(res).toEqual({ lastSeq: 11, reason: "ended" });
    } finally {
      await hub.stop();
    }
  });

  it("(b) server restart mid-stream → resume from cursor: no duplicates, no loss", async () => {
    let hub = start();
    const port = hub.port;
    const { callId, token } = await newCall();
    const got: number[] = [];
    const logs: string[] = [];
    try {
      for (let s = 1; s <= 3; s++) await say(callId, s);
      const run = pollRemoteTranscript({
        baseUrl: `http://127.0.0.1:${port}`, callId, token, intervalMs: 30,
        backoff: { baseMs: 20, capMs: 100 }, log: (m) => void logs.push(m),
        onLine: (_l, seq) => void got.push(seq),
      });
      while (got.length < 3) await Bun.sleep(10);
      await hub.stop(); // server goes away
      for (let s = 4; s <= 6; s++) await say(callId, s); // lines land while it's down
      await Bun.sleep(150); // client sees connection errors and backs off
      hub = start(port); // server comes back on the same address
      for (let s = 7; s <= 8; s++) await say(callId, s);
      await end(callId);
      await run;
      expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(logs.some((m) => m.includes("retrying"))).toBe(true);
    } finally {
      await hub.stop();
    }
  });

  it("(c) token for call A cannot read call B: same bodyless 403 as a nonexistent call; client stops clearly", async () => {
    const hub = start();
    try {
      const a = await newCall();
      const b = await newCall(tenantB);
      await say(b.callId, 1);
      const nonexistent = randomUUID();

      const hdr = { authorization: `Bearer ${a.token}` };
      const rB = await fetch(`${hub.url}/calls/${b.callId}/transcript?since_seq=0`, { headers: hdr });
      const rX = await fetch(`${hub.url}/calls/${nonexistent}/transcript?since_seq=0`, { headers: hdr });
      const bodyB = await rB.text();
      const bodyX = await rX.text();
      expect({ status: rB.status, body: bodyB }).toEqual({ status: 403, body: "" });
      expect({ status: rX.status, body: bodyX }).toEqual({ status: 403, body: "" });
      expect(rB.headers.get("content-type")).toBe(rX.headers.get("content-type"));

      const got: string[] = [];
      let err: unknown;
      try {
        await pollRemoteTranscript({ baseUrl: hub.url, callId: b.callId, token: a.token, intervalMs: 30, log: () => {}, onLine: (l) => void got.push(l) });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RemoteAuthError);
      expect((err as Error).message).toContain("access denied (HTTP 403)");
      expect(got).toEqual([]);
    } finally {
      await hub.stop();
    }
  });

  it("(d) the token never appears in a URL or in log/stdout output", async () => {
    const hub = start();
    try {
      const { callId, token } = await newCall();
      await say(callId, 1);
      await end(callId);
      const { f, seen } = recordingFetch();
      const logs: string[] = [];
      const out: string[] = [];
      await pollRemoteTranscript({ baseUrl: hub.url, callId, token, intervalMs: 30, fetch: f as typeof fetch, log: (m) => void logs.push(m), onLine: (l) => void out.push(l) });
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) {
        expect(s.url).not.toContain(token);
        expect(new URL(s.url).searchParams.has("token")).toBe(false);
        expect(s.auth).toBe(`Bearer ${token}`);
      }
      for (const m of [...logs, ...out]) expect(m).not.toContain(token);
    } finally {
      await hub.stop();
    }
  });

  it("BURST: 200 lines injected as fast as possible → all 200, in seq order, no duplicates (default 2 s interval)", async () => {
    const hub = start();
    try {
      const { callId, token } = await newCall();
      const got: number[] = [];
      let lastAt = 0;
      const run = pollRemoteTranscript({
        baseUrl: hub.url, callId, token, log: () => {},
        onLine: (_l, seq) => {
          got.push(seq);
          lastAt = performance.now();
        },
      });
      await Bun.sleep(50);
      const firstInject = performance.now();
      for (let s = 1; s <= 200; s++) await say(callId, s);
      while (got.length < 200) await Bun.sleep(10);
      await end(callId);
      await run;
      expect(got).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
      console.log(`[burst] 200 lines: first inject → last line ${Math.round(lastAt - firstInject)} ms`);
    } finally {
      await hub.stop();
    }
  }, 20_000);

  (SLOW ? it : it.skip)(
    "LONG IDLE (SAMOGRAPH_SLOW_TESTS=1): 120 s silence then 1 line → arrives, no errors, no restart",
    async () => {
      // Default REST cap (120 req/min per token) and default 2 s interval — the
      // realistic configuration, so an idle client must stay under the cap.
      const hub = start(0, new RequestRateCaps());
      try {
        const { callId, token } = await newCall();
        const got: number[] = [];
        const logs: string[] = [];
        let requests = 0;
        const f = (input: string | URL | Request, init?: RequestInit) => {
          requests++;
          return fetch(input, init);
        };
        const run = pollRemoteTranscript({
          baseUrl: hub.url, callId, token, fetch: f as typeof fetch, log: (m) => void logs.push(m),
          onLine: (_l, seq) => void got.push(seq),
        });
        await Bun.sleep(120_000);
        const idleRequests = requests;
        const idleErrors = logs.length;
        const t0 = performance.now();
        await say(callId, 1);
        while (got.length < 1) await Bun.sleep(10);
        const lat = performance.now() - t0;
        await end(callId);
        await run;
        expect(got).toEqual([1]);
        expect(idleErrors).toBe(0);
        console.log(
          `[idle] 120 s: requests=${idleRequests} (${(idleRequests / 2).toFixed(1)}/min), ` +
            `errors/reconnects=${idleErrors}, post-idle line latency ${Math.round(lat)} ms`,
        );
      } finally {
        await hub.stop();
      }
    },
    150_000,
  );
});
