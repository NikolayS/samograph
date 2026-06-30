/**
 * LIVE TRANSPORT end-to-end (SPEC §4.1, §5.2–§5.6; issue #99 — the capstone).
 *
 * Drives the WHOLE live path through REAL servers on loopback, on the
 * deterministic in-repo Recall fake (no tokens, no network beyond localhost):
 *
 *   fake `POST /webhook` → ingest §5.3 front door → composed dispatch
 *     (pipeline persists the line + publishes the §98 signal; lifecycle flips
 *      JOINING→IN_CALL) → after-commit FAN-IN re-hydrates the line by seq under
 *      RLS → Hub → FLUSH-ON-PUBLISH → a subscribed WS client receives the line.
 *
 * RED (before this issue): no `Bun.serve`/upgrade, no Hub→connection notify, no
 * fan-in — a webhook persisted a row but NOTHING reached an open WS. GREEN: the
 * exact live line (a >8 KB utterance — the #98 case) arrives on the socket.
 *
 * DB-gated (real Postgres + real RLS); skips cleanly when DATABASE_URL is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import { inMemoryWebhookSecretProvider } from "../ingest/webhook.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import { mintShareToken, revokeToken } from "../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { Session } from "../../packages/shared/auth/index.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { composeLiveStack, type LiveStackHandle } from "./liveBridge.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY_CURRENT: SigningKey = { kid: "lt1", secret: "live-transport-secret-aaaaaaaaaaaaaaaaaaaa" };
const keyring: Keyring = { current: KEY_CURRENT };

/** A WS client that records frames and lets a test await one matching a predicate. */
function openClient(baseWsUrl: string, callId: string, opts: { cookie?: string; token?: string }) {
  const u = new URL(`${baseWsUrl}/calls/${callId}/stream`);
  if (opts.token) u.searchParams.set("token", opts.token);
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
  const ws = new WebSocket(u.toString().replace(/^http/, "ws"), { headers } as unknown as string[]);

  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{ pred: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = [];
  ws.onmessage = (e: MessageEvent) => {
    const f = JSON.parse(String(e.data)) as Record<string, unknown>;
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) {
        waiters[i].resolve(f);
        waiters.splice(i, 1);
      }
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error / upgrade refused"));
  });
  function waitFor(pred: (f: Record<string, unknown>) => boolean, ms = 4000): Promise<Record<string, unknown>> {
    const existing = frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  }
  return { ws, frames, opened, waitFor };
}

/** Poll `cond` until true or timeout (deterministic barrier, no fixed sleeps). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

d("live transport: fake webhook → live WS line, end-to-end (#99)", () => {
  let sql: SQL;
  let stack: LiveStackHandle;
  const fake = createRecallFake({ seed: `live-${randomUUID()}` });

  const userA = randomUUID();
  const tenantA = randomUUID();
  const callId = randomUUID();
  const userB = randomUUID();
  const tenantB = randomUUID();

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

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
      VALUES (${callId}, ${tenantA}, 'https://meet.google.com/live', 'JOINING', 'us-east',
              ${fake.botId}, ${sha256Hex(fake.ingestSecret)})`;

    stack = composeLiveStack({
      sql,
      authDeps,
      secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
      recheckIntervalMs: 250, // snappy revoke-recheck for the SLO assertion below
    });
  });

  afterAll(async () => {
    await stack.stop();
    await sql`DELETE FROM webhook_events WHERE bot_id = ${fake.botId}`;
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`; // CASCADE clears the rest
    await sql.close();
  }, 10000);

  /** POST a signed fake webhook envelope at the REAL ingest server. */
  async function postWebhook(env: { url: string; headers: Record<string, string>; rawBody: string }) {
    const u = new URL(env.url);
    const target = `${stack.ingest.url}${u.pathname}${u.search}`;
    return fetch(target, { method: "POST", headers: env.headers, body: env.rawBody });
  }

  it("a >8 KB utterance flows fake-webhook → pipeline → fan-in → live WS line", async () => {
    const client = openClient(stack.wsHub.url, callId, { cookie: "cookie-A" });
    await client.opened;
    // Barrier: the server's openStream has subscribed before we publish (no race).
    await until(() => stack.hub.subscriberCount(callId) >= 1);

    // 1) in_call_recording → JOINING→IN_CALL + the §5.9 disclosure chat (no WS line).
    const rec = await postWebhook(fake.webhook(fake.lifecycle("in_call_recording")));
    expect(rec.status).toBe(200);

    // 2) a >8 KB transcript line — the #98 long-utterance case, end-to-end.
    const bigWord = "x".repeat(9000);
    const tx = await postWebhook(fake.webhook(fake.transcriptData({ speaker: "Alice", words: [bigWord] })));
    expect(tx.status).toBe(200);

    // The LIVE WS receives the exact line frame (re-hydrated by seq under RLS).
    const line = await client.waitFor((f) => f.type === "line" && f.seq === 1);
    expect(line.speaker).toBe("Alice");
    expect(line.text).toBe(bigWord);
    expect((line.text as string).length).toBe(9000);

    // Persisted durably too (the row the fan-in fetched), and IN_CALL.
    const rows = await sql`SELECT text FROM transcripts WHERE call_id = ${callId} AND seq = 1`;
    expect((rows[0] as { text: string }).text).toBe(bigWord);
    const status = await sql`SELECT status FROM calls WHERE id = ${callId}`;
    expect((status[0] as { status: string }).status).toBe("IN_CALL");
    // The disclosure was posted exactly once on in_call_recording (§5.9).
    expect(stack.worker.chats).toHaveLength(1);

    client.ws.close();
  });

  it("a cross-tenant session is refused the upgrade (no WS opens)", async () => {
    const client = openClient(stack.wsHub.url, callId, { cookie: "cookie-B" });
    await expect(client.opened).rejects.toThrow();
  });

  it("a revoked share token closes the open WS within the recheck SLO", async () => {
    const { token, jti } = await mintShareToken(sql, { callId, signingKey: KEY_CURRENT, ttlSeconds: 3600 });
    const client = openClient(stack.wsHub.url, callId, { token });
    await client.opened;
    await until(() => stack.hub.subscriberCount(callId) >= 1);

    const closed = new Promise<number>((resolve) => {
      client.ws.onclose = (e: CloseEvent) => resolve(e.code);
    });
    expect(await revokeToken(sql, jti)).toBe(true);
    // The per-connection recheck timer (≤ 1 s) re-runs the gate and closes the socket.
    const code = await Promise.race([
      closed,
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error("socket not closed in time")), 4000)),
    ]);
    expect(code).toBeGreaterThan(0);
    await until(() => stack.hub.subscriberCount(callId) === 0, 2000);
  });
});
