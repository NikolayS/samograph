/**
 * ws-hub `startWsHubServer` — health/404 + the SHARE-CAP SLOT-LEAK guard
 * (DB-gated; skips when DATABASE_URL unset).
 *
 * `server.ts` reserves a ShareCaps slot in `prepareStream` BEFORE the WS upgrade;
 * a non-Upgrade GET returns 426 AFTER reserving, so the slot must be released
 * (server.ts:107) or it's a share-cap DoS (every failed upgrade permanently burns
 * a slot). With maxConcurrent:1 we prove: a 426'd GET frees the slot (a real WS
 * open with the SAME token still succeeds), and while a WS holds the only slot a
 * new establish is 429'd (SAMO-RATE-001). Each slot test uses a FRESH server+caps
 * so a prior test's async socket-close release can't bleed in.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import type { SQL } from "bun";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { mintShareToken } from "../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { ShareCaps, RATE_LIMIT_ERROR_CODE } from "./caps.ts";
import { startWsHubServer, type WsHubServerHandle } from "./server.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;
const KEY: SigningKey = { kid: "cap1", secret: "server-caps-secret-aaaaaaaaaaaaaaaaaaaaaaaa" };
const keyring: Keyring = { current: KEY };

function openWs(handle: WsHubServerHandle, callId: string, token: string) {
  const u = new URL(`${handle.url}/calls/${callId}/stream`);
  u.searchParams.set("token", token);
  const ws = new WebSocket(u.toString().replace(/^http/, "ws"));
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("upgrade refused"));
  });
  return { ws, opened };
}
const streamUrl = (h: WsHubServerHandle, callId: string, token: string) =>
  `${h.url}/calls/${callId}/stream?token=${encodeURIComponent(token)}`;

d("startWsHubServer health/404 + share-cap slot-leak guard", () => {
  let sql: SQL;
  const userA = randomUUID();
  const tenantA = randomUUID();
  const callId = randomUUID();
  let token = "";

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
  /** A fresh server with its own maxConcurrent:1 caps (no cross-test slot bleed). */
  const fresh = () => startWsHubServer({ sql, authDeps, caps: new ShareCaps({ maxConcurrent: 1 }), port: 0 });

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${`${userA}@a.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status) VALUES
      (${callId}, ${tenantA}, 'https://meet.google.com/cap', 'IN_CALL')`;
    ({ token } = await mintShareToken(sql, { callId, signingKey: KEY, ttlSeconds: 3600 }));
  });
  afterAll(async () => {
    await sql`DELETE FROM users WHERE id = ${userA}`; // CASCADE clears the rest
    await sql.close();
  }, 10000);

  it("GET /health → 200 'ok', unknown path → 404", async () => {
    const h = fresh();
    try {
      const health = await fetch(`${h.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");
      expect((await fetch(`${h.url}/nope`)).status).toBe(404);
    } finally {
      await h.stop();
    }
  });

  it("a 426'd (non-Upgrade) GET frees the reserved slot — a WS open with the SAME token still succeeds", async () => {
    const h = fresh();
    try {
      // Non-WS GET: prepareStream GRANTS + reserves the (only) slot; upgrade refused → 426.
      const refused = await fetch(streamUrl(h, callId, token));
      expect(refused.status).toBe(426);
      // If the slot leaked, this open would be 429'd (maxConcurrent:1). It succeeds ⇒ released.
      const a = openWs(h, callId, token);
      await a.opened;
      a.ws.close();
    } finally {
      await h.stop();
    }
  });

  it("while a WS holds the only slot, a new establish is 429 SAMO-RATE-001 with Retry-After", async () => {
    const h = fresh();
    try {
      const a = openWs(h, callId, token);
      await a.opened; // holds the 1 slot
      const over = await fetch(streamUrl(h, callId, token));
      expect(over.status).toBe(429);
      expect(((await over.json()) as { code?: string }).code).toBe(RATE_LIMIT_ERROR_CODE); // SAMO-RATE-001
      expect(over.headers.get("retry-after")).not.toBeNull();
      a.ws.close();
    } finally {
      await h.stop();
    }
  });
});
