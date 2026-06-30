/**
 * Transcript replay/backfill + REST gap-resync tests — §6.2 #3 (SPEC §5.5,
 * §5.6, §5.10). DB-backed against the CI ephemeral Postgres (real migrations,
 * real RLS); skips cleanly when DATABASE_URL is unset.
 *
 * Strict red/green TDD, exact-value assertions:
 *   • {@link replayTranscripts}: seed seq 1..100 → `since_seq=42` returns 43..100
 *     ascending with no gaps/dupes; `since_seq ≥ max` returns EMPTY (not error);
 *     a cross-tenant read returns NOTHING (RLS).
 *   • {@link backfillRecent}: ascending window of the most recent lines.
 *   • {@link createTranscriptHandler}: `GET /calls/:id/transcript?since_seq=N`
 *     gate-authorized (read/share), bodyless 403 on deny, and a hub gap-frame →
 *     REST round-trip that recovers EXACTLY the dropped range.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { connect, setTenant } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { mintShareToken } from "../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { Session } from "../../packages/shared/auth/index.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import { Hub, type GapFrame } from "./hub.ts";
import { replayTranscripts, backfillRecent, type TranscriptLine } from "./transcript.ts";
import { createTranscriptHandler, type TranscriptResponseBody } from "./transcript-http.ts";
import type { StreamAuthDeps } from "./stream.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const KEY_CURRENT: SigningKey = { kid: "k2", secret: "ws-transcript-current-secret-bbbbbbbbbbbb" };
const keyring: Keyring = { current: KEY_CURRENT };

function liveFrame(seq: number) {
  return { type: "line", seq, ts: "2026-01-01T00:00:00.000Z", speaker: null, text: `live ${seq}` };
}

d("transcript replay/backfill + REST (§5.5 / §5.6 / §5.10)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID(); // tenant A, seeded with seq 1..100
  const callB = randomUUID(); // tenant B, no transcripts

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

  /** Run an RLS-scoped read as the app role with `tenantId` set. */
  async function asTenant<T>(tenantId: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
    return sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx as unknown as SQL, tenantId);
      return fn(tx as unknown as SQL);
    });
  }

  function transcriptReq(
    callId: string,
    opts: { cookie?: string; token?: string; since?: number } = {},
  ): Request {
    const u = new URL(`http://ws-hub.local/calls/${callId}/transcript`);
    if (opts.token) u.searchParams.set("token", opts.token);
    if (opts.since !== undefined) u.searchParams.set("since_seq", String(opts.since));
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
    return new Request(u.toString(), { headers });
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
      (${callB}, ${tenantB}, 'https://meet.google.com/bbb', 'IN_CALL')`;
    await sql`
      INSERT INTO transcripts (call_id, seq, ts, speaker, text)
      SELECT ${callA}, g, now() - (interval '1 second' * (100 - g)), 'Speaker ' || g, 'line ' || g
      FROM generate_series(1, 100) AS g`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`; // CASCADE clears the rest
    await sql.close();
  });

  // ── replayTranscripts (the WS/REST replay query) ──────────────────────────
  it("replay since_seq=42 → exactly seq 43..100 ascending, no gaps or dupes", async () => {
    const lines = await asTenant(tenantA, (tx) => replayTranscripts(tx, callA, 42));
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 58 }, (_, i) => i + 43));
    expect(lines[0]).toMatchObject({ seq: 43, speaker: "Speaker 43", text: "line 43" });
    expect(lines.at(-1)).toMatchObject({ seq: 100, speaker: "Speaker 100", text: "line 100" });
  });

  it("replay since_seq=0 → the whole transcript 1..100", async () => {
    const lines = await asTenant(tenantA, (tx) => replayTranscripts(tx, callA, 0));
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("replay since_seq ≥ max returns EMPTY (not an error)", async () => {
    expect(await asTenant(tenantA, (tx) => replayTranscripts(tx, callA, 100))).toEqual([]);
    expect(await asTenant(tenantA, (tx) => replayTranscripts(tx, callA, 5000))).toEqual([]);
  });

  it("cross-tenant replay returns NOTHING (RLS hides callA from tenant B)", async () => {
    const lines = await asTenant(tenantB, (tx) => replayTranscripts(tx, callA, 0));
    expect(lines).toEqual([]);
  });

  // ── backfillRecent (the cold subscribe window) ────────────────────────────
  it("backfillRecent returns the most recent `limit` lines, ascending", async () => {
    const all = await asTenant(tenantA, (tx) => backfillRecent(tx, callA, 200));
    expect(all.map((l) => l.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

    const last10 = await asTenant(tenantA, (tx) => backfillRecent(tx, callA, 10));
    expect(last10.map((l) => l.seq)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  // ── REST GET /calls/:id/transcript ────────────────────────────────────────
  it("GET …/transcript?since_seq=42 with an own-tenant session → 200 with seq 43..100", async () => {
    const handler = createTranscriptHandler({ sql, authDeps });
    const res = await handler(transcriptReq(callA, { cookie: "cookie-A", since: 42 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TranscriptResponseBody;
    expect(body.call_id).toBe(callA);
    expect(body.since_seq).toBe(42);
    expect(body.lines.map((l: TranscriptLine) => l.seq)).toEqual(Array.from({ length: 58 }, (_, i) => i + 43));
  });

  it("GET …/transcript with a valid share token → 200 (scope `share`)", async () => {
    const { token } = await mintShareToken(sql, { callId: callA, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const handler = createTranscriptHandler({ sql, authDeps });
    const res = await handler(transcriptReq(callA, { token, since: 98 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TranscriptResponseBody;
    expect(body.lines.map((l: TranscriptLine) => l.seq)).toEqual([99, 100]);
  });

  it("GET …/transcript?since_seq=100 (≥ max) → 200 with an empty range", async () => {
    const handler = createTranscriptHandler({ sql, authDeps });
    const res = await handler(transcriptReq(callA, { cookie: "cookie-A", since: 100 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TranscriptResponseBody).lines).toEqual([]);
  });

  it("no credential → bodyless 403 (gate DENY)", async () => {
    const handler = createTranscriptHandler({ sql, authDeps });
    const res = await handler(transcriptReq(callA, { since: 0 }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  it("cross-tenant session → bodyless 403, and never leaks tenant A's lines", async () => {
    const handler = createTranscriptHandler({ sql, authDeps });
    const res = await handler(transcriptReq(callA, { cookie: "cookie-B", since: 0 }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  // ── AC #6: hub gap frame → REST round-trip recovers the EXACT dropped range ─
  it("a hub gap frame is recovered exactly by the REST backfill round-trip", async () => {
    // Overflow the subscriber by 10 → drop oldest 1..10 as a single contiguous
    // gap{since_seq:1, until_seq:10} (the 256-message cap, §5.5).
    const hub = new Hub();
    const sub = hub.subscribe(callA);
    for (let seq = 1; seq <= 266; seq++) hub.publish(callA, liveFrame(seq));
    const gap = sub.drain().find((f) => (f as GapFrame).type === "gap") as GapFrame;
    expect(gap).toEqual({ type: "gap", since_seq: 1, until_seq: 10 });

    // Client recovers the dropped range from the DB via REST (since_seq = gap-1).
    const handler = createTranscriptHandler({ sql, authDeps });
    const res = await handler(transcriptReq(callA, { cookie: "cookie-A", since: gap.since_seq - 1 }));
    const body = (await res.json()) as TranscriptResponseBody;
    const recovered = body.lines
      .filter((l: TranscriptLine) => l.seq >= gap.since_seq && l.seq <= gap.until_seq)
      .map((l: TranscriptLine) => l.seq);
    expect(recovered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // exactly the dropped range, contiguous
  });
});
