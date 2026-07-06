/**
 * liveBridge NEGATIVE after-commit gate (DB-gated; skips when DATABASE_URL unset).
 *
 * The live path's central safety claim is asserted nowhere: `liveBridge.ts`
 * delivers a line to the Hub ONLY after the ingest §5.3 gate + dedup tx commit
 * with a 200 (`if (res.status === 200)`). A regression there would silently leak
 * REJECTED / rolled-back webhook content to live viewers. This test proves the
 * gate holds end-to-end through the REAL composed servers: a webhook that fails
 * auth (wrong `?t=`) is 401'd and its content reaches NEITHER the live socket NOR
 * the DB, while a valid webhook right after IS delivered — so the gate discriminates.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import { inMemoryWebhookSecretProvider } from "../ingest/webhook.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import type { Session } from "../../packages/shared/auth/index.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { composeLiveStack, type LiveStackHandle } from "./liveBridge.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY: SigningKey = { kid: "lbn1", secret: "livebridge-neg-secret-aaaaaaaaaaaaaaaaaaaa" };
const keyring: Keyring = { current: KEY };

function openClient(baseWsUrl: string, callId: string, cookie: string) {
  const u = new URL(`${baseWsUrl}/calls/${callId}/stream`);
  const ws = new WebSocket(u.toString().replace(/^http/, "ws"), {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  } as unknown as string[]);
  const frames: Array<Record<string, unknown>> = [];
  ws.onmessage = (e: MessageEvent) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws upgrade refused"));
  });
  return { ws, frames, opened };
}
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const hasText = (frames: Array<Record<string, unknown>>, t: string) =>
  frames.some((f) => f.type === "line" && f.text === t);

d("liveBridge negative gate: a rejected webhook reaches neither the socket nor the DB", () => {
  let sql: SQL;
  let stack: LiveStackHandle;
  const fake = createRecallFake({ seed: `lbn-${randomUUID()}` });
  const userA = randomUUID();
  const tenantA = randomUUID();
  const callId = randomUUID();
  const REJECTED = "this-was-REJECTED-must-never-appear";
  const ACCEPTED = "this-was-accepted-and-delivered";

  const authDeps: StreamAuthDeps = {
    keyring,
    lookupSession: async (c) => (c === "cookie-A" ? ({ userId: userA, tenantId: tenantA } as Session) : null),
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
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${`${userA}@a.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
      VALUES (${callId}, ${tenantA}, 'https://meet.google.com/lbn', 'JOINING', 'us-east',
              ${fake.botId}, ${sha256Hex(fake.ingestSecret)})`;
    stack = composeLiveStack({
      sql,
      authDeps,
      secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
    });
  });
  afterAll(async () => {
    await stack.stop();
    await sql`DELETE FROM webhook_events WHERE bot_id = ${fake.botId}`;
    await sql`DELETE FROM users WHERE id = ${userA}`; // CASCADE clears tenant/call/transcripts
    await sql.close();
  }, 10000);

  async function postWebhook(env: { url: string; headers: Record<string, string>; rawBody: string }) {
    const u = new URL(env.url);
    return fetch(`${stack.ingest.url}${u.pathname}${u.search}`, { method: "POST", headers: env.headers, body: env.rawBody });
  }

  it("GET /health?nonce=abc echoes {ok:true,nonce:'abc'}", async () => {
    const res = await fetch(`${stack.ingest.url}/health?nonce=abc`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, nonce: "abc" });
  });

  it("a wrong-?t= webhook is 401'd and its line reaches neither the WS nor transcripts, but a valid one does", async () => {
    const client = openClient(stack.wsHub.url, callId, "cookie-A");
    await client.opened;
    await until(() => stack.hub.subscriberCount(callId) >= 1);

    // rejected: valid body+signature but a ?t= that hashes to no call → 401, no dispatch.
    const bad = fake.webhook(fake.transcriptData({ speaker: "Mallory", words: [REJECTED] }));
    const badUrl = new URL(bad.url);
    badUrl.search = "?t=wrong-secret-no-call-has-this-000000000000000000000000000000";
    const rej = await postWebhook({ ...bad, url: badUrl.toString() });
    expect(rej.status).toBe(401);

    // accepted: a valid webhook right after → 200 and IT is delivered live.
    const ok = await postWebhook(fake.webhook(fake.transcriptData({ speaker: "Alice", words: [ACCEPTED] })));
    expect(ok.status).toBe(200);
    await until(() => hasText(client.frames, ACCEPTED), 4000);

    // The gate discriminated: accepted delivered, rejected NEVER reached the socket…
    expect(hasText(client.frames, ACCEPTED)).toBe(true);
    expect(hasText(client.frames, REJECTED)).toBe(false);
    // …nor the DB. Exactly one row (the accepted line); none carrying the rejected text.
    const rows = await sql`SELECT text FROM transcripts WHERE call_id = ${callId} ORDER BY seq`;
    expect(rows.map((r: { text: string }) => r.text)).toEqual([ACCEPTED]);

    client.ws.close();
  });
});
