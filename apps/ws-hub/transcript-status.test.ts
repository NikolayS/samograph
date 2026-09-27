/**
 * #307 prototype 1 (plain polling): `GET /calls/:id/transcript` must tell a
 * polling client whether the call has ENDED, so `samograph watch --remote` can
 * stop cleanly instead of polling forever. DB-backed (real migrations + RLS);
 * skips cleanly when DATABASE_URL is unset.
 *
 * Contract (exact values):
 *   • IN_CALL call  → body.status === "IN_CALL", body.ended === false
 *   • ENDED call    → body.status === "ENDED",   body.ended === true
 *   • every terminal status (ENDED / COULD_NOT_JOIN / COULD_NOT_RECORD /
 *     BOT_REMOVED) → ended === true
 *   • the status is read BEFORE the lines, in the same authorized tx, so
 *     `ended:true` means the returned tail is complete.
 *   • a share token sent ONLY in `Authorization: Bearer` is accepted.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { mintShareToken } from "../../packages/shared/tokens/store.ts";
import type { Keyring, SigningKey } from "../../packages/shared/tokens/signing.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { createTranscriptHandler, type TranscriptResponseBody } from "./transcript-http.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const KEY: SigningKey = { kid: "k307s", secret: "ws-transcript-status-secret-cccccccccccc" };
const keyring: Keyring = { current: KEY };

d("GET /calls/:id/transcript exposes call status for polling clients (#307)", () => {
  let sql: ReturnType<typeof connect>;
  const user = randomUUID();
  const tenant = randomUUID();
  const calls: Record<string, string> = {
    IN_CALL: randomUUID(),
    ENDED: randomUUID(),
    COULD_NOT_JOIN: randomUUID(),
    COULD_NOT_RECORD: randomUUID(),
    BOT_REMOVED: randomUUID(),
  };

  const authDeps: StreamAuthDeps = {
    keyring,
    lookupSession: async () => null,
    lookupCallTenant: async (id) => {
      const r = await sql`SELECT tenant_id FROM calls WHERE id = ${id}`;
      return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
    },
  };

  async function get(callId: string, since: number): Promise<TranscriptResponseBody> {
    const { token } = await mintShareToken(sql, { callId, signingKey: KEY, ttlSeconds: 600 });
    const handler = createTranscriptHandler({ sql, authDeps });
    const res = await handler(
      new Request(`http://ws-hub.local/calls/${callId}/transcript?since_seq=${since}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as TranscriptResponseBody;
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@status.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenant}, ${user})`;
    for (const [status, id] of Object.entries(calls)) {
      await sql`INSERT INTO calls (id, tenant_id, meeting_url, status)
        VALUES (${id}, ${tenant}, 'https://meet.google.com/sss', ${status}::call_status)`;
    }
    await sql`INSERT INTO transcripts (call_id, seq, ts, speaker, text) VALUES
      (${calls.IN_CALL}, 1, '2026-01-01T00:00:01Z', 'Alice', 'one'),
      (${calls.IN_CALL}, 2, '2026-01-01T00:00:02Z', 'Bob', 'two'),
      (${calls.ENDED}, 1, '2026-01-01T00:00:01Z', 'Alice', 'bye')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id = ${user}`;
    await sql.close();
  });

  it("IN_CALL → status IN_CALL, ended false, lines after the cursor", async () => {
    const body = await get(calls.IN_CALL!, 1);
    expect(body.status).toBe("IN_CALL");
    expect(body.ended).toBe(false);
    expect(body.lines.map((l) => l.seq)).toEqual([2]);
  });

  it("ENDED → status ENDED, ended true, and the final tail is still returned", async () => {
    const body = await get(calls.ENDED!, 0);
    expect(body.status).toBe("ENDED");
    expect(body.ended).toBe(true);
    expect(body.lines.map((l) => l.text)).toEqual(["bye"]);
  });

  it("every terminal status reports ended true", async () => {
    for (const s of ["COULD_NOT_JOIN", "COULD_NOT_RECORD", "BOT_REMOVED"]) {
      const body = await get(calls[s]!, 0);
      expect({ s, status: body.status, ended: body.ended }).toEqual({ s, status: s, ended: true });
    }
  });
});
