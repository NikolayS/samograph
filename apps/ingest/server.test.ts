/**
 * ingest `Bun.serve` ENTRYPOINT — composed front door + watchdog driver (#99).
 *
 * Pure cases (no DB): the §4.5 /health marker + 404 routing. DB-gated cases:
 *   • the FULL composed path (front door → dispatch → §98 PgListenNotifyPublisher)
 *     persists a >8 KB line and returns 200 — the in-tx NOTIFY signal never rolls
 *     back the dedup+insert (the production half of the #98 fix);
 *   • `startRegionWatchdogs` discovers a region and drives a real degrade.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import type { SQL } from "bun";
import type { HealthFetch } from "../../src/server.ts";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import { InMemoryTranscriptPublisher, PgListenNotifyPublisher } from "../../packages/shared/transcript/publisher.ts";
import {
  inMemoryWebhookMetrics,
  inMemoryWebhookSecretProvider,
  pgLookupCallByBotId,
} from "./webhook.ts";
import { inMemoryTranscriptMetrics } from "./transcriptPipeline.ts";
import { inMemoryBotWorker, inMemoryBotLifecycleMetrics } from "./botLifecycle.ts";
import { inMemoryWatchdogMetrics } from "./tunnelWatchdog.ts";
import { createIngestApp, buildIngestDispatch, startRegionWatchdogs } from "./server.ts";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("createIngestApp routing (no DB)", () => {
  const app = createIngestApp({
    sql: {} as SQL,
    dispatch: async () => {},
    secretProvider: inMemoryWebhookSecretProvider("s"),
    metrics: inMemoryWebhookMetrics(),
    lookupCallByBotId: async () => null,
  });

  it("GET /health echoes the byte-exact samograph-health marker (§4.5)", async () => {
    const res = await app(new Request("http://ingest.local/health?nonce=abc"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, nonce: "abc", marker: "samograph-health" });
  });

  it("an unknown path falls through to the webhook front door's 404", async () => {
    expect((await app(new Request("http://ingest.local/nope"))).status).toBe(404);
  });
});

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("createIngestApp + PgListenNotifyPublisher — composed path persists a >8 KB line (#98/#99)", () => {
  let sql: SQL;
  const fake = createRecallFake({ seed: `ingest-srv-${randomUUID()}` });
  const userId = randomUUID();
  const tenantId = randomUUID();
  const callId = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@i.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
      VALUES (${callId}, ${tenantId}, 'https://meet.google.com/is', 'IN_CALL', 'us-east',
              ${fake.botId}, ${sha256Hex(fake.ingestSecret)})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM webhook_events WHERE bot_id = ${fake.botId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.close();
  });

  it("a >8 KB transcript webhook → 200 and the row persists (in-tx signal NOTIFY does not roll back)", async () => {
    const app = createIngestApp({
      sql,
      dispatch: buildIngestDispatch({
        publisher: new PgListenNotifyPublisher(sql), // the real §98 publisher, in-tx
        worker: inMemoryBotWorker(),
        transcriptMetrics: inMemoryTranscriptMetrics(),
        lifecycleMetrics: inMemoryBotLifecycleMetrics(),
      }),
      secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
      metrics: inMemoryWebhookMetrics(),
      lookupCallByBotId: pgLookupCallByBotId(sql),
    });

    const bigWord = "x".repeat(9000);
    const env = fake.webhook(fake.transcriptData({ speaker: "Alice", words: [bigWord] }));
    const u = new URL(env.url);
    const res = await app(new Request(`http://ingest.local${u.pathname}${u.search}`, {
      method: "POST", headers: env.headers, body: env.rawBody,
    }));

    expect(res.status).toBe(200);
    const rows = await sql`SELECT seq, text FROM transcripts WHERE call_id = ${callId}`;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { text: string }).text).toBe(bigWord);
  });
});

d("startRegionWatchdogs — driver discovers a region and degrades it (#81/#99)", () => {
  let sql: SQL;
  const regionId = `wd-srv-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO regions (id, tunnel_hostname, status)
      VALUES (${regionId}, 'tunnel.local', 'healthy')`;
  });
  afterAll(async () => {
    await sql`DELETE FROM regions WHERE id = ${regionId}`;
    await sql.close();
  });

  it("two failing probes flip the region to degraded via the started watchdog", async () => {
    const failingProbe: HealthFetch = async () => {
      throw new Error("tunnel down");
    };
    const driver = await startRegionWatchdogs({
      sql,
      replicaId: `replica-${randomUUID().slice(0, 8)}`,
      publisher: new InMemoryTranscriptPublisher(),
      metrics: inMemoryWatchdogMetrics(),
      fetch: failingProbe,
      now: () => new Date(),
      regionIds: [regionId], // skip discovery; drive exactly this region
    });
    try {
      expect(driver.handles).toHaveLength(1);
      await driver.handles[0].tick(); // failure #1 → still healthy (threshold 2)
      expect((await sql`SELECT status FROM regions WHERE id = ${regionId}`)[0].status).toBe("healthy");
      await driver.handles[0].tick(); // failure #2 → degraded
      expect((await sql`SELECT status FROM regions WHERE id = ${regionId}`)[0].status).toBe("degraded");
      expect(driver.handles[0].isLeader()).toBe(true);
    } finally {
      driver.stop();
    }
  });
});
