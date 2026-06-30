/**
 * `GET /calls/:id/stream` WS upgrade tests — §6.2 #3/#4 (SPEC §5.5, §5.6, §5.10).
 *
 * Strict red/green TDD, exact-value assertions. Two surfaces:
 *   1. Pure, always-run: request parsing, the bodyless-403 deny (socket never
 *      opened), and the {@link StreamConnection} backfill-then-live boundary
 *      dedupe + gap forwarding + revoke recheck — no DB.
 *   2. DB-backed (CI ephemeral Postgres; skips cleanly when DATABASE_URL unset):
 *      authorize-per-upgrade through the REAL tenancy gate as the non-super
 *      `samograph_app` role — session→`read`, share→`share`; the adversarial
 *      denials; NO verifier cache (N upgrades ⇒ N token DB lookups; a revoke
 *      between upgrades denies the next); `?since_seq` replay-then-live; and a
 *      revoke closing an OPEN socket on recheck (≤ 1 s SLO).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { mintShareToken, revokeToken } from "../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { Session } from "../../packages/shared/auth/index.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import { Hub } from "./hub.ts";
import type { TranscriptLine } from "./transcript.ts";
import {
  parseStreamRequest,
  prepareStream,
  openStream,
  StreamConnection,
  RECHECK_INTERVAL_MS,
  type StreamAuthDeps,
  type StreamSocket,
  type PrepareStreamResult,
} from "./stream.ts";
import { ShareCaps } from "./caps.ts";

// ─── fakes / helpers ────────────────────────────────────────────────────────

/** A socket sink that records everything sent and the close it received. */
class FakeSocket implements StreamSocket {
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closedWith === null) this.closedWith = { code, reason };
  }
  /** Parsed frames sent so far. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  /** seqs of the data ("line") frames sent, in order. */
  lineSeqs(): number[] {
    return this.frames()
      .filter((f) => f.type === "line")
      .map((f) => f.seq as number);
  }
}

/** A finalized line for the backfill API. */
function line(seq: number): TranscriptLine {
  return { seq, ts: "2026-01-01T00:00:00.000Z", speaker: null, text: `line ${seq}` };
}

/** A live data frame as ingest would publish onto the hub. */
function liveFrame(seq: number) {
  return { type: "line", seq, ts: "2026-01-01T00:00:00.000Z", speaker: null, text: `live ${seq}` };
}

const DUMMY_KEY: SigningKey = { kid: "k1", secret: "x".repeat(32) };
const DUMMY_KEYRING: Keyring = { current: DUMMY_KEY };

/** A no-op SQL whose `begin` just runs the callback with a never-queried tx. */
function fakeSql(): SQL {
  // Built untyped then cast once: the real `SQL.begin` is heavily overloaded, so
  // a typed partial would not satisfy it — the gate never queries this tx anyway
  // (no credentials ⇒ DENY before any DB access).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tx: any = () => Promise.resolve([] as unknown[]);
  tx.unsafe = () => Promise.resolve([] as unknown[]);
  const sql: any = () => Promise.resolve([] as unknown[]);
  sql.begin = (cb: (t: SQL) => unknown) => Promise.resolve(cb(tx as SQL));
  sql.unsafe = () => Promise.resolve([] as unknown[]);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return sql as SQL;
}

const NO_CRED_DEPS: StreamAuthDeps = {
  keyring: DUMMY_KEYRING,
  lookupSession: async () => null,
  lookupCallTenant: async () => null,
};

// =============================================================================
// 1. Pure surface — always run (no DB).
// =============================================================================
describe("parseStreamRequest (no DB)", () => {
  it("extracts callId, since_seq, and a `?token=` share token", () => {
    const req = new Request("http://ws-hub.local/calls/abc-123/stream?since_seq=42&token=tkn");
    const p = parseStreamRequest(req);
    expect(p).not.toBeNull();
    expect(p!.callId).toBe("abc-123");
    expect(p!.sinceSeq).toBe(42);
    expect(p!.credentials.shareToken).toBe("tkn");
    expect(p!.credentials.sessionCookie).toBeNull();
  });

  it("reads the share token from an Authorization: Bearer header and the session cookie", () => {
    const req = new Request("http://ws-hub.local/calls/c1/stream", {
      headers: { authorization: "Bearer abc.def", cookie: `${SESSION_COOKIE_NAME}=sess-1; other=z` },
    });
    const p = parseStreamRequest(req)!;
    expect(p.credentials.shareToken).toBe("abc.def");
    expect(p.credentials.sessionCookie).toBe("sess-1");
    expect(p.sinceSeq).toBeNull();
  });

  it("returns null for a non-stream path", () => {
    expect(parseStreamRequest(new Request("http://ws-hub.local/calls/c1"))).toBeNull();
    expect(parseStreamRequest(new Request("http://ws-hub.local/calls/c1/transcript"))).toBeNull();
  });

  it("rejects a non-numeric / negative since_seq as no cursor (null)", () => {
    for (const bad of ["-1", "1.5", "x", "0x10", " "]) {
      const req = new Request(`http://ws-hub.local/calls/c1/stream?since_seq=${encodeURIComponent(bad)}`);
      expect(parseStreamRequest(req)!.sinceSeq).toBeNull();
    }
    // a plain "0" IS a valid cursor (replay everything).
    expect(parseStreamRequest(new Request("http://ws-hub.local/calls/c1/stream?since_seq=0"))!.sinceSeq).toBe(0);
  });
});

describe("prepareStream deny — no credential (no DB)", () => {
  it("denies with a bodyless 403 and never opens a socket", async () => {
    const req = new Request(`http://ws-hub.local/calls/${randomUUID()}/stream`);
    const res = await prepareStream(fakeSql(), req, NO_CRED_DEPS);
    expect(res.ok).toBe(false);
    const denied = res as Extract<PrepareStreamResult, { ok: false }>;
    expect(denied.response.status).toBe(403);
    expect(await denied.response.text()).toBe("");
  });

  it("denies a non-stream path the same way (no socket)", async () => {
    const res = await prepareStream(fakeSql(), new Request("http://ws-hub.local/health"), NO_CRED_DEPS);
    expect(res.ok).toBe(false);
  });
});

describe("StreamConnection backfill-then-live (no DB)", () => {
  function setup(initialSeq = 0, reauthorize: () => Promise<boolean> = async () => true) {
    const hub = new Hub();
    const subscriber = hub.subscribe("call-1");
    const socket = new FakeSocket();
    const conn = new StreamConnection({
      socket,
      hub,
      callId: "call-1",
      scope: "read",
      subscriber,
      initialSeq,
      reauthorize,
    });
    return { hub, socket, conn };
  }

  it("sends backfill in order, then live frames newer than the boundary, deduping the boundary seq", () => {
    const { hub, socket, conn } = setup();
    conn.sendBackfill([line(1), line(2), line(3)]); // boundary advances to 3
    expect(conn.highWaterSeq()).toBe(3);

    hub.publish("call-1", liveFrame(3)); // duplicate of the boundary → dropped
    hub.publish("call-1", liveFrame(4));
    hub.publish("call-1", liveFrame(5));
    conn.flush();

    expect(socket.lineSeqs()).toEqual([1, 2, 3, 4, 5]); // exactly once each, in order
    expect(conn.highWaterSeq()).toBe(5);
  });

  it("a second flush only delivers strictly-newer seqs (no re-send, no gap)", () => {
    const { hub, socket, conn } = setup();
    conn.sendBackfill([line(10)]);
    hub.publish("call-1", liveFrame(11));
    conn.flush();
    hub.publish("call-1", liveFrame(11)); // stale duplicate
    hub.publish("call-1", liveFrame(12));
    conn.flush();
    expect(socket.lineSeqs()).toEqual([10, 11, 12]);
  });

  it("forwards the hub's gap control frame verbatim before the surviving data", () => {
    const { hub, socket, conn } = setup();
    // Overflow the subscriber's 256-message cap by one → drop oldest (seq 1),
    // hub enqueues a single gap{since:1,until:1} at the head.
    for (let seq = 1; seq <= 257; seq++) hub.publish("call-1", liveFrame(seq));
    conn.flush();
    const frames = socket.frames();
    expect(frames[0]).toEqual({ type: "gap", since_seq: 1, until_seq: 1 });
    expect(socket.lineSeqs()).toEqual(Array.from({ length: 256 }, (_, i) => i + 2)); // 2..257
  });

  it("replay boundary (initialSeq=N): a live frame at seq=N is never duplicated", () => {
    const { hub, socket, conn } = setup(42);
    conn.sendBackfill([line(43), line(44)]); // the replay tail seq > 42
    hub.publish("call-1", liveFrame(42)); // the boundary itself, arriving live
    hub.publish("call-1", liveFrame(45));
    conn.flush();
    expect(socket.lineSeqs()).toEqual([43, 44, 45]); // no 42, no gap
  });

  it("recheck closes the socket when the grant is gone, and stays open while authorized", async () => {
    const revoked = setup(0, async () => false);
    expect(await revoked.conn.recheck()).toBe(false);
    expect(revoked.socket.closedWith).not.toBeNull();
    expect(revoked.conn.isClosed()).toBe(true);

    const live = setup(0, async () => true);
    expect(await live.conn.recheck()).toBe(true);
    expect(live.socket.closedWith).toBeNull();
    expect(live.conn.isClosed()).toBe(false);
  });

  it("the revoke recheck interval is ≤ 1 s so a revoke closes the socket within the SLO", () => {
    expect(RECHECK_INTERVAL_MS).toBeLessThanOrEqual(1000);
  });
});

describe("StreamConnection share caps wiring (no DB)", () => {
  function shareConn(caps: ShareCaps, capKey: string | undefined, scope: "read" | "share") {
    const hub = new Hub();
    const socket = new FakeSocket();
    const conn = new StreamConnection({
      socket,
      hub,
      callId: "call-1",
      scope,
      subscriber: hub.subscribe("call-1"),
      initialSeq: 0,
      reauthorize: async () => true,
      caps,
      capKey,
      clockMs: () => 0, // pinned clock: the command window never slides here
    });
    return { conn, socket };
  }

  it("a share connection's command() enforces the per-connection command cap", () => {
    const caps = new ShareCaps({ commandsPerWindow: 2 });
    const { conn } = shareConn(caps, "tok-key", "share");
    expect(conn.command().allowed).toBe(true);
    expect(conn.command().allowed).toBe(true);
    const over = conn.command();
    expect(over.allowed).toBe(false); // the 3rd command exceeds the cap of 2
    expect(over.retryAfterMs).toBeGreaterThan(0);
  });

  it("a read connection is NEVER share-command-capped, even with caps present", () => {
    const caps = new ShareCaps({ commandsPerWindow: 2 });
    const { conn } = shareConn(caps, undefined, "read");
    for (let i = 0; i < 10; i++) expect(conn.command().allowed).toBe(true);
  });

  it("a share connection releases its concurrent slot on close()", () => {
    const caps = new ShareCaps();
    caps.tryEstablish("tok-key", 0); // the slot reserved at establish time
    expect(caps.concurrent("tok-key")).toBe(1);
    const { conn } = shareConn(caps, "tok-key", "share");
    conn.close();
    expect(caps.concurrent("tok-key")).toBe(0); // freed exactly once on close
    conn.close(); // idempotent — does not double-release
    expect(caps.concurrent("tok-key")).toBe(0);
  });
});

// =============================================================================
// 2. DB-backed — real Postgres, real RLS, real tenancy gate + verifier.
// =============================================================================
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const KEY_CURRENT: SigningKey = { kid: "k2", secret: "ws-stream-current-secret-aaaaaaaaaaaaaaaaaaaa" };
const keyring: Keyring = { current: KEY_CURRENT };

d("GET /calls/:id/stream — DB-backed (§5.5 / §5.6 / §6.2 #3/#4)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID(); // tenant A, seeded with transcripts seq 1..100
  const callX = randomUUID(); // tenant A, second call (binding-check isolation)
  const callB = randomUUID(); // tenant B

  const sessions = new Map<string, Session>([
    ["cookie-A", { userId: userA, tenantId: tenantA }],
    ["cookie-B", { userId: userB, tenantId: tenantB }],
  ]);

  const authDeps: StreamAuthDeps = {
    keyring,
    lookupSession: async (cookie) => sessions.get(cookie) ?? null,
    lookupCallTenant: async (id) => {
      try {
        const r = await sql`SELECT tenant_id FROM calls WHERE id = ${id}`;
        return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
      } catch {
        return null;
      }
    },
  };

  /** Build a `/calls/:id/stream` upgrade request. */
  function streamReq(
    callId: string,
    opts: { cookie?: string; token?: string; since?: number } = {},
  ): Request {
    const u = new URL(`http://ws-hub.local/calls/${callId}/stream`);
    if (opts.token) u.searchParams.set("token", opts.token);
    if (opts.since !== undefined) u.searchParams.set("since_seq", String(opts.since));
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
    return new Request(u.toString(), { headers });
  }

  /** Mirror production wiring: prepare → (if granted) open the socket. */
  async function upgrade(socket: FakeSocket, hub: Hub, req: Request) {
    const prepared = await prepareStream(sql, req, authDeps);
    if (!prepared.ok) return { opened: false as const, response: prepared.response };
    const conn = await openStream(socket, prepared, { sql, hub, authDeps });
    return { opened: true as const, conn, scope: prepared.scope };
  }

  /** Same wiring, but with the share caps threaded through prepare + open. */
  async function upgradeWithCaps(socket: FakeSocket, hub: Hub, req: Request, caps: ShareCaps) {
    const deps = { ...authDeps, caps };
    const prepared = await prepareStream(sql, req, deps);
    if (!prepared.ok) return { opened: false as const, response: prepared.response };
    const conn = await openStream(socket, prepared, { sql, hub, authDeps: deps, caps });
    return { opened: true as const, conn, scope: prepared.scope };
  }

  /**
   * Wrap `sql` so every `… FROM tokens …` read inside a `begin` is counted —
   * proves the gate does ONE token DB lookup per upgrade (no verifier cache).
   */
  function tokenReadCounter(real: SQL) {
    let count = 0;
    const wrapTx = (tx: SQL) =>
      new Proxy(tx as unknown as object, {
        apply(target, _thisArg, args) {
          const strings = args[0];
          if (Array.isArray(strings) && strings.join(" ").toLowerCase().includes("from tokens")) count++;
          return Reflect.apply(target as (...a: unknown[]) => unknown, undefined, args);
        },
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as SQL;
    const proxy = new Proxy(real as unknown as object, {
      get(target, prop, receiver) {
        if (prop === "begin") {
          return (cb: (tx: SQL) => unknown) =>
            (real as unknown as { begin: (c: (tx: SQL) => unknown) => Promise<unknown> }).begin((tx) =>
              cb(wrapTx(tx)),
            );
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
      apply(target, _thisArg, args) {
        return Reflect.apply(target as (...a: unknown[]) => unknown, undefined, args);
      },
    }) as unknown as SQL;
    return { sql: proxy, count: () => count };
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/aaa', 'IN_CALL'),
      (${callX}, ${tenantA}, 'https://meet.google.com/xxx', 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://meet.google.com/bbb', 'IN_CALL')`;
    // Seed callA with finalized lines seq 1..100 (ts ascending with seq).
    await sql`
      INSERT INTO transcripts (call_id, seq, ts, speaker, text)
      SELECT ${callA}, g, now() - (interval '1 second' * (100 - g)), 'Speaker ' || g, 'line ' || g
      FROM generate_series(1, 100) AS g`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`; // CASCADE clears the rest
    await sql.close();
  });

  // ── AC #1: authorized upgrades carry the right scope ──────────────────────
  it("session cookie for an own-tenant call → upgrade granted, scope `read`", async () => {
    const socket = new FakeSocket();
    const hub = new Hub();
    const r = await upgrade(socket, hub, streamReq(callA, { cookie: "cookie-A", since: 99 }));
    expect(r.opened).toBe(true);
    if (r.opened) expect(r.scope).toBe("read");
  });

  it("valid call-bound share token → upgrade granted, scope `share`", async () => {
    const { token } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const socket = new FakeSocket();
    const hub = new Hub();
    const r = await upgrade(socket, hub, streamReq(callA, { token, since: 100 }));
    expect(r.opened).toBe(true);
    if (r.opened) expect(r.scope).toBe("share");
  });

  // ── AC #2: adversarial denials → 403, socket never opened ─────────────────
  it("adversarial credentials are denied 403 and never open a socket", async () => {
    const expired = await mintShareToken(sql, {
      callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 60, now: Math.floor(Date.now() / 1000) - 10_000,
    });
    const boundToX = await mintShareToken(sql, { callId: callX, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const crossTenant = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });

    const cases: Array<[string, Request]> = [
      ["no credential", streamReq(callA)],
      ["cross-tenant session", streamReq(callA, { cookie: "cookie-B" })],
      ["session on a call outside its tenant", streamReq(callB, { cookie: "cookie-A" })],
      ["expired token", streamReq(callA, { token: expired.token })],
      ["token bound to call X used on call A", streamReq(callA, { token: boundToX.token })],
      ["tenant A token used on tenant B call", streamReq(callB, { token: crossTenant.token })],
      ["garbage token", streamReq(callA, { token: "not.a.real.token" })],
    ];

    for (const [name, req] of cases) {
      const socket = new FakeSocket();
      const hub = new Hub();
      const r = await upgrade(socket, hub, req);
      expect(r.opened, `${name} should be denied`).toBe(false);
      if (!r.opened) {
        expect(r.response.status, name).toBe(403);
        expect(await r.response.text(), name).toBe("");
      }
      expect(socket.sent.length, `${name}: nothing sent`).toBe(0);
      expect(hub.subscriberCount(callA) + hub.subscriberCount(callB), `${name}: not subscribed`).toBe(0);
    }
  });

  // ── AC #3: NO verifier cache — one token DB lookup per upgrade ─────────────
  it("no cache: N upgrades ⇒ N token DB lookups, and a revoke between upgrades denies the next", async () => {
    const { token, jti } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const counter = tokenReadCounter(sql);

    const N = 3;
    for (let i = 0; i < N; i++) {
      const res = await prepareStream(counter.sql, streamReq(callA, { token }), authDeps);
      expect(res.ok, `upgrade #${i + 1} granted`).toBe(true);
    }
    expect(counter.count()).toBe(N); // exactly one `FROM tokens` read per upgrade

    // Revoke, then the very next upgrade is denied — no stale grant survived.
    const t0 = performance.now();
    expect(await revokeToken(sql, jti)).toBe(true);
    const after = await prepareStream(counter.sql, streamReq(callA, { token }), authDeps);
    const elapsed = performance.now() - t0;
    console.log(`[stream/no-cache] tokenReads=${counter.count()} revoke→deny=${elapsed.toFixed(1)}ms`);
    expect(after.ok).toBe(false);
    expect(counter.count()).toBe(N + 1); // the denied upgrade still hit the DB
    expect(elapsed).toBeLessThan(1000);
  });

  // ── AC #5: ?since_seq replay-then-live, no dup of boundary, no gap ─────────
  it("?since_seq=42 replays exactly seq 43..100 then resumes live with no duplicate of 42", async () => {
    const socket = new FakeSocket();
    const hub = new Hub();
    const r = await upgrade(socket, hub, streamReq(callA, { cookie: "cookie-A", since: 42 }));
    expect(r.opened).toBe(true);

    // Backfill replayed exactly the missing tail.
    expect(socket.lineSeqs()).toEqual(Array.from({ length: 58 }, (_, i) => i + 43)); // 43..100

    if (r.opened) {
      hub.publish(callA, liveFrame(42)); // the boundary, arriving live → must be deduped
      hub.publish(callA, liveFrame(101));
      r.conn.flush();
    }
    expect(socket.lineSeqs()).toEqual([...Array.from({ length: 58 }, (_, i) => i + 43), 101]);
    expect(socket.lineSeqs()).not.toContain(42);
  });

  it("a fresh (no since_seq) subscription backfills the last lines then streams live", async () => {
    const socket = new FakeSocket();
    const hub = new Hub();
    const r = await upgrade(socket, hub, streamReq(callA, { cookie: "cookie-A" }));
    expect(r.opened).toBe(true);
    // 100 seeded lines < 200 window → all of 1..100 ascending.
    expect(socket.lineSeqs()).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    if (r.opened) {
      hub.publish(callA, liveFrame(101));
      hub.publish(callA, liveFrame(50)); // stale → deduped
      r.conn.flush();
    }
    expect(socket.lineSeqs().at(-1)).toBe(101);
    expect(socket.lineSeqs().filter((s) => s === 50).length).toBe(1); // only the backfilled 50
  });

  // ── revoke closes an OPEN socket on recheck (≤ 1 s SLO, §5.5) ──────────────
  it("a share token revoked mid-stream closes the open socket on the next recheck (no cache)", async () => {
    const { token, jti } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const socket = new FakeSocket();
    const hub = new Hub();
    const r = await upgrade(socket, hub, streamReq(callA, { token, since: 100 }));
    expect(r.opened).toBe(true);
    if (!r.opened) return;
    expect(socket.closedWith).toBeNull();

    expect(await revokeToken(sql, jti)).toBe(true);
    const t0 = performance.now();
    const stillOk = await r.conn.recheck();
    const elapsed = performance.now() - t0;
    console.log(`[stream/revoke-close] recheck→close=${elapsed.toFixed(1)}ms ok=${stillOk}`);
    expect(stillOk).toBe(false);
    expect(r.conn.isClosed()).toBe(true);
    expect(socket.closedWith).not.toBeNull();
    expect(elapsed).toBeLessThan(1000);
    expect(hub.subscriberCount(callA)).toBe(0); // unsubscribed on close
  });

  // ── §6.2 #10: share caps wired onto the upgrade (over-cap → 429 + Retry-After) ─
  it("a share upgrade over the concurrent cap → 429 SAMO-RATE-001 + Retry-After; closing frees a slot", async () => {
    const caps = new ShareCaps({ maxConcurrent: 1 });
    const { token } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });

    // 1st share connection on the token is admitted and opens.
    const s1 = new FakeSocket();
    const r1 = await upgradeWithCaps(s1, new Hub(), streamReq(callA, { token, since: 100 }), caps);
    expect(r1.opened).toBe(true);

    // 2nd concurrent connection on the SAME token exceeds the cap → 429, no socket.
    const s2 = new FakeSocket();
    const r2 = await upgradeWithCaps(s2, new Hub(), streamReq(callA, { token, since: 100 }), caps);
    expect(r2.opened).toBe(false);
    if (!r2.opened) {
      expect(r2.response.status).toBe(429);
      expect(r2.response.headers.get("Retry-After")).not.toBeNull();
      expect(((await r2.response.json()) as { code: string }).code).toBe("SAMO-RATE-001");
    }
    expect(s2.sent.length).toBe(0); // nothing streamed to a rejected upgrade

    // Closing the 1st frees the single slot → a new connection is admitted again.
    if (r1.opened) r1.conn.close();
    const s3 = new FakeSocket();
    const r3 = await upgradeWithCaps(s3, new Hub(), streamReq(callA, { token, since: 100 }), caps);
    expect(r3.opened).toBe(true);
  });

  it("read connections are NOT subject to share caps: a 0-slot cap admits read but rejects share", async () => {
    const caps = new ShareCaps({ maxConcurrent: 0 }); // zero share slots

    // A session (read) upgrade still opens — read is never share-capped.
    const sRead = new FakeSocket();
    const rRead = await upgradeWithCaps(sRead, new Hub(), streamReq(callA, { cookie: "cookie-A", since: 100 }), caps);
    expect(rRead.opened).toBe(true);
    if (rRead.opened) expect(rRead.scope).toBe("read");

    // A share upgrade under the same 0-slot cap is rejected → the cap is on the share path.
    const { token } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const sShare = new FakeSocket();
    const rShare = await upgradeWithCaps(sShare, new Hub(), streamReq(callA, { token, since: 100 }), caps);
    expect(rShare.opened).toBe(false);
    if (!rShare.opened) expect(rShare.response.status).toBe(429);
  });

  // ── §6.2 #10 AC#5: revoke kills the token's share sockets only ──────────────
  it("revoke closes the token's share socket but leaves a read connection AND a different share token open", async () => {
    const s1 = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const s2 = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });

    const sockS1 = new FakeSocket();
    const sockS2 = new FakeSocket();
    const sockRead = new FakeSocket();
    const hub = new Hub();
    const connS1 = await upgrade(sockS1, hub, streamReq(callA, { token: s1.token, since: 100 }));
    const connS2 = await upgrade(sockS2, hub, streamReq(callA, { token: s2.token, since: 100 }));
    const connRead = await upgrade(sockRead, hub, streamReq(callA, { cookie: "cookie-A", since: 100 }));
    expect(connS1.opened && connS2.opened && connRead.opened).toBe(true);
    if (!connS1.opened || !connS2.opened || !connRead.opened) return;

    // Revoke ONLY share token s1.
    expect(await revokeToken(sql, s1.jti)).toBe(true);

    // Next recheck (no cache): s1 closes within the SLO; s2 + read stay open.
    const t0 = performance.now();
    const okS1 = await connS1.conn.recheck();
    const elapsed = performance.now() - t0;
    const okS2 = await connS2.conn.recheck();
    const okRead = await connRead.conn.recheck();
    console.log(
      `[stream/share-revoke-isolation] s1→close=${elapsed.toFixed(1)}ms s2.open=${okS2} read.open=${okRead}`,
    );

    expect(okS1).toBe(false);
    expect(connS1.conn.isClosed()).toBe(true);
    expect(sockS1.closedWith).not.toBeNull();
    expect(elapsed).toBeLessThan(1000);

    expect(okS2).toBe(true); // a DIFFERENT share token on the same call is unaffected
    expect(connS2.conn.isClosed()).toBe(false);
    expect(sockS2.closedWith).toBeNull();

    expect(okRead).toBe(true); // the read connection on the same call is unaffected
    expect(connRead.conn.isClosed()).toBe(false);
    expect(sockRead.closedWith).toBeNull();
  });
});
