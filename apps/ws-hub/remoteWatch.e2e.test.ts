/**
 * Tunnel-free remote watch over WebSocket — REAL stack end-to-end (#307, 3/3).
 *
 *   signed fake webhook → REAL ingest → Postgres (seq under advisory lock)
 *     → after-commit fan-in → Hub → ws-hub `GET /calls/:id/stream`
 *     → the CLI client (`remoteWatch`) authenticated by a per-call SHARE token
 *       sent ONLY in `Authorization: Bearer` (never `?token=`).
 *
 * Covers (a) since_seq replay, (b) the server keepalive ping, (c) reconnect
 * with no loss/dupe, (e) call-A token cannot open call B, (f) no token in logs,
 * plus the two cross-prototype comparison tests: BURST (200 lines as fast as
 * possible) and LONG IDLE (120 s silence, behind SAMOGRAPH_SLOW_TESTS=1).
 *
 * DB-gated (real Postgres + real RLS); skips cleanly when DATABASE_URL is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import { inMemoryWebhookSecretProvider } from "../ingest/webhook.ts";
import { mintShareToken } from "../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { WS_PING_INTERVAL_MS } from "./server.ts";
import { composeLiveStack, type LiveStackHandle } from "./liveBridge.ts";
import { remoteWatch, type RemoteLine, type RemoteWatchEvent } from "../../src/remoteWatch.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;
const SLOW = process.env.SAMOGRAPH_SLOW_TESTS === "1";
const BURST_CONCURRENCY = Number(process.env.BURST_CONCURRENCY ?? 8);

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY: SigningKey = { kid: "rw1", secret: "remote-watch-test-secret-aaaaaaaaaaaaaa" };
const keyring: Keyring = { current: KEY };

describe("ws-hub keepalive constant (pure)", () => {
  it("pings well inside Cloudflare's ~100 s idle-WebSocket cutoff (≤ 30 s)", () => {
    expect(WS_PING_INTERVAL_MS).toBeLessThanOrEqual(30_000);
    expect(WS_PING_INTERVAL_MS).toBeGreaterThan(0);
  });
});

async function until(cond: () => boolean, ms = 4000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A running remoteWatch with its collected output. */
function watchCall(site: string, callId: string, token: string, extra: { sinceSeq?: number; backoffBaseMs?: number } = {}) {
  const seqs: number[] = [];
  const rendered: string[] = [];
  const arrivals = new Map<number, number>();
  const logs: string[] = [];
  const events: RemoteWatchEvent[] = [];
  const ctl = new AbortController();
  const done = remoteWatch({
    site,
    callId,
    token,
    signal: ctl.signal,
    sinceSeq: extra.sinceSeq,
    backoffBaseMs: extra.backoffBaseMs ?? 50,
    onLine: (r: string, l: RemoteLine) => {
      seqs.push(l.seq);
      rendered.push(r);
      arrivals.set(l.seq, performance.now());
    },
    log: (m) => logs.push(m),
    onEvent: (e) => events.push(e),
  });
  return { seqs, rendered, arrivals, logs, events, done, stop: async () => { ctl.abort(); return done; } };
}

d("remote watch over WS — real ingest + ws-hub + Postgres (#307)", () => {
  let sql: SQL;
  let stack: LiveStackHandle;
  const fake = createRecallFake({ seed: `rw-${randomUUID()}` });
  const fakeB = createRecallFake({ seed: `rwB-${randomUUID()}` });
  let offset = 0;

  const user = randomUUID();
  const tenant = randomUUID();
  const callA = randomUUID();
  const callB = randomUUID();
  let tokenA = "";

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

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@rw.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenant}, ${user})`;
    // Two calls in the SAME tenant: isolation must hold per call, not just per tenant.
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash) VALUES
      (${callA}, ${tenant}, 'https://meet.google.com/rw-a', 'JOINING', 'us-east', ${fake.botId}, ${sha256Hex(fake.ingestSecret)}),
      (${callB}, ${tenant}, 'https://meet.google.com/rw-b', 'JOINING', 'us-east', ${fakeB.botId}, ${sha256Hex(fakeB.ingestSecret)})`;
    stack = composeLiveStack({
      sql,
      authDeps,
      secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
      pingIntervalMs: SLOW ? undefined : 100, // fast pings for (b); defaults for the slow idle run
    });
    tokenA = (await mintShareToken(sql, { callId: callA, signingKey: KEY, ttlSeconds: 3600 })).token;
  });

  afterAll(async () => {
    await stack.stop();
    await sql`DELETE FROM webhook_events WHERE bot_id IN (${fake.botId}, ${fakeB.botId})`;
    await sql`DELETE FROM users WHERE id = ${user}`;
    await sql.close();
  }, 10000);

  /** Say one line on call A through the REAL signed-webhook ingest path. */
  async function say(text: string): Promise<void> {
    const env = fake.webhook(fake.transcriptData({ speaker: "Alice", words: text.split(" ") }), { offset: ++offset });
    const u = new URL(env.url);
    const res = await fetch(`${stack.ingest.url}${u.pathname}${u.search}`, {
      method: "POST",
      headers: env.headers,
      body: env.rawBody,
    });
    expect(res.status).toBe(200);
  }

  async function maxSeq(): Promise<number> {
    const r = await sql`SELECT COALESCE(MAX(seq), 0)::int AS m FROM transcripts WHERE call_id = ${callA}`;
    return (r[0] as { m: number }).m;
  }

  it("(a) since_seq=2 delivers only seq ≥ 3, exactly once, in order", async () => {
    for (let i = 1; i <= 5; i++) await say(`hello ${i}`);
    expect(await maxSeq()).toBe(5);
    const w = watchCall(stack.wsHub.url, callA, tokenA, { sinceSeq: 2 });
    await until(() => w.seqs.length >= 3, 4000, "3 lines");
    await say("hello 6");
    await until(() => w.seqs.length >= 4, 4000, "live line");
    await Bun.sleep(100); // let any stray duplicate land before asserting
    await w.stop();
    expect(w.seqs).toEqual([3, 4, 5, 6]);
    expect(w.rendered[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Alice: hello 3$/);
    expect(w.rendered[3]).toMatch(/\] Alice: hello 6$/);
  });

  it("(b) the server pings an idle socket (client observes ping frames with no traffic)", async () => {
    const from = await maxSeq();
    const w = watchCall(stack.wsHub.url, callA, tokenA, { sinceSeq: from });
    await until(() => w.events.some((e) => e.type === "open"), 4000, "open");
    await until(() => w.events.filter((e) => e.type === "ping").length >= 2, 4000, "2 pings");
    await w.stop();
    expect(w.seqs).toEqual([]); // idle: pings, no data
  });

  it("(c) reconnect mid-stream: every line exactly once, in order (incl. lines said while down)", async () => {
    const from = await maxSeq();
    const w = watchCall(stack.wsHub.url, callA, tokenA, { sinceSeq: from, backoffBaseMs: 300 });
    await until(() => w.events.some((e) => e.type === "open"), 4000, "open");
    for (let i = 1; i <= 3; i++) await say(`before ${i}`);
    await until(() => w.seqs.length >= 3, 4000, "3 before");
    // Drop the socket the way a laptop sleep / network flap would.
    const open = w.events.find((e) => e.type === "open") as Extract<RemoteWatchEvent, { type: "open" }>;
    open.drop();
    for (let i = 1; i <= 3; i++) await say(`during ${i}`); // said while disconnected
    await until(() => w.events.filter((e) => e.type === "open").length >= 2, 4000, "reconnect");
    for (let i = 1; i <= 3; i++) await say(`after ${i}`);
    await until(() => w.seqs.length >= 9, 4000, "9 lines");
    await Bun.sleep(100);
    await w.stop();
    expect(w.seqs).toEqual(Array.from({ length: 9 }, (_, i) => from + 1 + i));
    expect(w.rendered.map((r) => r.replace(/^\[[^\]]+\] Alice: /, ""))).toEqual([
      "before 1", "before 2", "before 3", "during 1", "during 2", "during 3", "after 1", "after 2", "after 3",
    ]);
  });

  it("(e) a token for call A cannot open call B: bodyless 403, socket never opens", async () => {
    // raw upgrade attempt → bodyless 403
    const res = await fetch(`${stack.wsHub.url}/calls/${callB}/stream?since_seq=0`, {
      headers: {
        authorization: `Bearer ${tokenA}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    // the client: never opens, stops with the auth reason, no subscription on B
    const w = watchCall(stack.wsHub.url, callB, tokenA);
    expect(await w.done).toEqual({ reason: "unauthorized", status: 403 });
    expect(w.events.some((e) => e.type === "open")).toBe(false);
    expect(stack.hub.subscriberCount(callB)).toBe(0);
    // (f) and the token appears in no log line
    expect(w.logs.join("\n")).toContain("not authorized");
    expect(w.logs.join("\n")).not.toContain(tokenA);
  });

  it("BURST: 200 lines fired as fast as possible → all 200, in seq order, no duplicates", async () => {
    const from = await maxSeq();
    const w = watchCall(stack.wsHub.url, callA, tokenA, { sinceSeq: from });
    await until(() => w.events.some((e) => e.type === "open"), 4000, "open");
    const t0 = performance.now();
    // Fire with BURST_CONCURRENCY webhooks in flight (default 8) — no pacing.
    let next = 0;
    const worker = async () => {
      while (next < 200) {
        const i = next++;
        await say(`burst ${i}`);
      }
    };
    await Promise.all(Array.from({ length: BURST_CONCURRENCY }, worker));
    await until(() => w.seqs.length >= 200, 20_000, "200 burst lines");
    const elapsed = performance.now() - t0;
    await Bun.sleep(200);
    await w.stop();
    expect(w.seqs).toEqual(Array.from({ length: 200 }, (_, i) => from + 1 + i));
    expect(new Set(w.seqs).size).toBe(200);
    const fills = w.events.filter((e) => e.type === "gap-fill").length;
    console.log(`[burst] 200 lines first-inject→last-arrival=${elapsed.toFixed(0)}ms gap-fills=${fills}`);
  }, 30_000);

  (SLOW ? it : it.skip)(
    "LONG IDLE (SAMOGRAPH_SLOW_TESTS=1): 120 s silence, then 1 line arrives without a manual restart",
    async () => {
      const from = await maxSeq();
      const w = watchCall(stack.wsHub.url, callA, tokenA, { sinceSeq: from });
      await until(() => w.events.some((e) => e.type === "open"), 4000, "open");
      await Bun.sleep(120_000);
      const t = performance.now();
      await say("after the long silence");
      await until(() => w.seqs.length >= 1, 10_000, "post-idle line");
      const lat = performance.now() - t;
      await w.stop();
      const opens = w.events.filter((e) => e.type === "open").length;
      const pings = w.events.filter((e) => e.type === "ping").length;
      console.log(`[idle] 120s: pings=${pings} reconnects=${opens - 1} post-idle latency=${lat.toFixed(1)}ms`);
      expect(w.seqs).toEqual([from + 1]);
      expect(pings).toBeGreaterThanOrEqual(3); // default 30 s interval → ~4 in 120 s
    },
    180_000,
  );
});
