/**
 * Webhook authenticity front door — adversarial + idempotency tests (SPEC §5.3,
 * §6.2 #7). Drives `POST /webhook?bot=&t=` entirely through the deterministic
 * in-repo Recall fake (no real Recall, no tokens, §6.1).
 *
 * The reject-ladder cases are pure (no DB): they assert the §5.3 order short-
 * circuits BEFORE any tenant transaction is opened, so they run on every PR.
 * The idempotency + dispatch cases need the real `webhook_events` table and are
 * gated on DATABASE_URL (the Postgres-smoke job runs the full suite).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import { connect } from "../../packages/shared/db/index.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import {
  createWebhookHandler,
  inMemoryWebhookMetrics,
  inMemoryWebhookSecretProvider,
  pgLookupCallByBotId,
  type CallIdentity,
  type ValidatedEvent,
  type WebhookHandlerDeps,
} from "./webhook.ts";

const SEED = "webhook-itest-seed";
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

// A `sql` stand-in for reject-path tests: any DB touch is a test failure, which
// is exactly the assertion that the §5.3 gate fails closed before any write.
const FORBIDDEN_SQL = new Proxy(
  {},
  {
    get() {
      throw new Error("reject path must not touch the database");
    },
  },
) as unknown as WebhookHandlerDeps["sql"];

function harness(overrides: Partial<WebhookHandlerDeps> = {}) {
  const fake = createRecallFake({ seed: SEED });
  const dispatched: ValidatedEvent[] = [];
  const warns: Array<{ code: string; fields: Record<string, unknown> }> = [];
  const metrics = inMemoryWebhookMetrics();
  let lookupCalls = 0;
  const identity: CallIdentity = {
    callId: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    ingestSecretHash: sha256Hex(fake.ingestSecret),
    recallBotId: fake.botId,
  };
  const deps: WebhookHandlerDeps = {
    secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
    lookupCallByBotId: async (botId) => {
      lookupCalls += 1;
      return botId === fake.botId ? identity : null;
    },
    sql: FORBIDDEN_SQL,
    dispatch: async (e) => {
      dispatched.push(e);
    },
    metrics,
    logger: { warn: (code, fields) => warns.push({ code, fields }) },
    ...overrides,
  };
  const handler = createWebhookHandler(deps);
  return { fake, handler, dispatched, warns, metrics, identity, lookupCalls: () => lookupCalls };
}

describe("webhook reject ladder — bodyless 4xx + one WARN + counter (§5.3, §6.2 #7)", () => {
  it("invalid Recall signature → 401, no body, exactly one WARN, dispatch never runs (#2)", async () => {
    const h = harness();
    const env = h.fake.badSignature(h.fake.webhook(h.fake.lifecycle("in_call_recording")));
    const res = await h.handler(new Request(env.url, { method: "POST", headers: env.headers, body: env.rawBody }));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(h.dispatched).toHaveLength(0);
    expect(h.warns).toEqual([
      { code: "SAMO-WEBHOOK-401", fields: { reason: "bad_signature" } },
    ]);
    expect(h.metrics.rejected).toEqual({ bad_signature: 1 });
    // Signature is step 1: the privileged bot lookup must not even be reached.
    expect(h.lookupCalls()).toBe(0);
  });

  it("valid signature but unknown ?bot= → 401 unknown_bot (#6 unknown bot)", async () => {
    const h = harness({ lookupCallByBotId: async () => null });
    const env = h.fake.webhook(h.fake.lifecycle("in_call_recording"));
    const res = await h.handler(new Request(env.url, { method: "POST", headers: env.headers, body: env.rawBody }));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(h.dispatched).toHaveLength(0);
    expect(h.metrics.rejected).toEqual({ unknown_bot: 1 });
    expect(h.warns.map((w) => w.code)).toEqual(["SAMO-WEBHOOK-401"]);
  });

  it("missing ?bot= → 401 unknown_bot", async () => {
    const h = harness();
    const env = h.fake.webhook(h.fake.lifecycle("in_call_recording"));
    const res = await h.handler(
      new Request("https://ingest.local/webhook?t=whatever", {
        method: "POST",
        headers: env.headers,
        body: env.rawBody,
      }),
    );
    expect(res.status).toBe(401);
    expect(h.metrics.rejected).toEqual({ unknown_bot: 1 });
    expect(h.dispatched).toHaveLength(0);
  });

  it("valid signature + valid ?bot= but ?t= mismatch → 401 (tokensEqual path) (#3)", async () => {
    const h = harness();
    // Same body/signature, but ?t= carries a guessed (wrong) ingest secret.
    const env = h.fake.webhook(h.fake.lifecycle("in_call_recording"), { ingestSecret: "guessed-wrong" });
    const res = await h.handler(new Request(env.url, { method: "POST", headers: env.headers, body: env.rawBody }));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(h.dispatched).toHaveLength(0);
    expect(h.metrics.rejected).toEqual({ ingest_secret_mismatch: 1 });
    // Exactly one WARN with the §5.16 code + reason (debug context fields allowed).
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0].code).toBe("SAMO-WEBHOOK-401");
    expect(h.warns[0].fields.reason).toBe("ingest_secret_mismatch");
  });

  it("missing ?t= → 401 ingest_secret_mismatch (fail closed on empty secret)", async () => {
    const h = harness();
    const env = h.fake.webhook(h.fake.lifecycle("in_call_recording"));
    const res = await h.handler(
      new Request(`https://ingest.local/webhook?bot=${h.fake.botId}`, {
        method: "POST",
        headers: env.headers,
        body: env.rawBody,
      }),
    );
    expect(res.status).toBe(401);
    expect(h.metrics.rejected).toEqual({ ingest_secret_mismatch: 1 });
    expect(h.dispatched).toHaveLength(0);
  });

  it("cross-tenant: body bot_id ≠ authenticated ?bot= → 403, gate before any write (#4)", async () => {
    const h = harness();
    const victim = createRecallFake({ seed: "victim-tenant-b" });
    // Authentic envelope for the ATTACKER's own bot (valid sig + ?bot= + ?t=),
    // but the BODY claims the victim's bot_id (a different tenant's call).
    const env = h.fake.webhook(victim.lifecycle("in_call_recording"));
    const res = await h.handler(new Request(env.url, { method: "POST", headers: env.headers, body: env.rawBody }));

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(h.dispatched).toHaveLength(0);
    expect(h.metrics.rejected).toEqual({ cross_tenant: 1 });
    // Exactly one WARN; the tenancy-gate denial is SAMO-AUTHZ-001 / 403 (§5.16).
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0].code).toBe("SAMO-AUTHZ-001");
    expect(h.warns[0].fields.reason).toBe("cross_tenant");
  });

  it("authenticated-but-malformed body (no recall_event_id / not JSON) → 401, never dispatch (#6)", async () => {
    const fake = createRecallFake({ seed: SEED });
    const secret = fake.webhookSecret;
    const { recallSignature } = await import("../../packages/shared/recall/signature.ts");
    const { RECALL_SIGNATURE_HEADER } = await import("../../packages/shared/recall/signature.ts");

    for (const rawBody of ['not json at all', '{"event":"bot.status_change","data":{}}', '{"recall_event_id":"e","event":"nope"}']) {
      const h = harness();
      const headers = { [RECALL_SIGNATURE_HEADER]: recallSignature(rawBody, secret), "content-type": "application/json" };
      const res = await h.handler(
        new Request(`https://ingest.local/webhook?bot=${fake.botId}&t=${fake.ingestSecret}`, {
          method: "POST",
          headers,
          body: rawBody,
        }),
      );
      expect(res.status).toBe(401);
      expect(res.status).not.toBe(200);
      expect(h.dispatched).toHaveLength(0);
      expect(h.metrics.rejected).toEqual({ malformed: 1 });
    }
  });

  it("fuzz corpus of UNSIGNED malformed bodies → never 2xx, never dispatch, each counts bad_signature (#6)", async () => {
    const corpus = [
      "",
      "{}",
      "[]",
      "null",
      "%%%not-json%%%",
      '{"event":"transcript.data"}',
      '{"recall_event_id":1,"event":"bot.status_change"}',
      " ",
      '{"a":'.repeat(50),
      JSON.stringify({ recall_event_id: "x".repeat(5000), event: "bot.status_change", data: {} }),
    ];
    for (const rawBody of corpus) {
      const h = harness();
      const res = await h.handler(
        new Request(`https://ingest.local/webhook?bot=${h.fake.botId}&t=${h.fake.ingestSecret}`, {
          method: "POST",
          headers: { "content-type": "application/json" }, // no/invalid signature
          body: rawBody,
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.status).not.toBe(200);
      expect(h.dispatched).toHaveLength(0);
      // Unsigned -> rejected at step 1 (signature), before the bot lookup.
      expect(h.metrics.rejected).toEqual({ bad_signature: 1 });
      expect(h.lookupCalls()).toBe(0);
    }
  });

  it("non-POST / non-/webhook requests are 404 (not a reject)", async () => {
    const h = harness();
    expect((await h.handler(new Request("https://ingest.local/webhook", { method: "GET" }))).status).toBe(404);
    expect((await h.handler(new Request("https://ingest.local/nope", { method: "POST" }))).status).toBe(404);
    expect(h.metrics.rejected).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency + dispatch seam — needs the real `webhook_events` table (§6.2 #7).
// ─────────────────────────────────────────────────────────────────────────────
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("webhook idempotency + dispatch (§5.3 step 4, §6.2 #7)", () => {
  let sql: ReturnType<typeof connect>;
  const fake = createRecallFake({ seed: "webhook-db-seed" });
  const userId = randomUUID();
  const tenantId = randomUUID();
  const callId = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@wh.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, recall_bot_id, ingest_secret_hash)
              VALUES (${callId}, ${tenantId}, 'https://meet.google.com/wh', 'IN_CALL',
                      ${fake.botId}, ${sha256Hex(fake.ingestSecret)})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM webhook_events WHERE bot_id = ${fake.botId}`;
    await sql`DELETE FROM calls WHERE id = ${callId}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.close();
  });

  function dbHarness() {
    const dispatched: ValidatedEvent[] = [];
    const metrics = inMemoryWebhookMetrics();
    const handler = createWebhookHandler({
      secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
      lookupCallByBotId: pgLookupCallByBotId(sql),
      sql,
      dispatch: async (e) => {
        dispatched.push(e);
      },
      metrics,
    });
    return { handler, dispatched, metrics };
  }

  it("happy path: 200 and dispatches the typed ValidatedEvent exactly once", async () => {
    const h = dbHarness();
    const env = fake.webhook(fake.lifecycle("in_call_recording"));
    const res = await h.handler(new Request(env.url, { method: "POST", headers: env.headers, body: env.rawBody }));

    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      kind: "bot.status_change",
      botId: fake.botId,
      callId,
      tenantId,
      recallEventId: env.recallEventId,
    });
    // The inner Recall payload is passed through untouched for #78/#79 to consume.
    expect((h.dispatched[0].payload as { event: string }).event).toBe("bot.status_change");
  });

  it("replay of the same (bot_id, recall_event_id) → dispatched at most once; second returns 200", async () => {
    const h = dbHarness();
    const env = fake.webhook(fake.lifecycle("in_call_not_recording"));
    const redelivery = fake.replay(env); // Recall re-delivers the same event bytes.

    const first = await h.handler(new Request(env.url, { method: "POST", headers: env.headers, body: env.rawBody }));
    const second = await h.handler(
      new Request(redelivery.url, { method: "POST", headers: redelivery.headers, body: redelivery.rawBody }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // At-least-once delivery, at-most-once dispatch (Recall redelivery is a no-op).
    expect(h.dispatched).toHaveLength(1);

    const count = await sql`SELECT count(*)::int AS c FROM webhook_events
                            WHERE bot_id = ${fake.botId} AND recall_event_id = ${env.recallEventId}`;
    expect(count[0].c).toBe(1);
  });

  it("webhook_events PK is exactly (bot_id, recall_event_id)", async () => {
    const rows = await sql`
      SELECT a.attname AS col
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'webhook_events'::regclass AND i.indisprimary
      ORDER BY a.attnum`;
    expect(rows.map((r: { col: string }) => r.col)).toEqual(["bot_id", "recall_event_id"]);
  });
});
