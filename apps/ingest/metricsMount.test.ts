/**
 * §5.11 production wiring (issue #108): the ingest `Bun.serve` entrypoint mounts
 * GET /metrics reading ONE injected shared {@link MetricsRegistry}, and that same
 * registry is the drop-in for the component counter ports (it structurally
 * replaces the per-process `inMemory*` fakes at the composition root).
 *
 * These cases are pure (no DB): they inject a shared registry, drive the counter
 * ports directly (the same methods the pipeline/webhook/lifecycle call), and
 * assert /metrics renders the EXACT Prometheus lines off that shared registry.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import type { SQL } from "bun";
import { MetricsRegistry, METRICS_CONTENT_TYPE } from "../../packages/shared/observe/index.ts";
import { inMemoryWebhookSecretProvider, pgLookupCallByBotId } from "./webhook.ts";
import { createIngestApp, buildIngestDispatch } from "./server.ts";
import { InMemoryTranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";
import { inMemoryBotWorker } from "./botLifecycle.ts";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

function appWithRegistry(registry?: MetricsRegistry) {
  return createIngestApp({
    sql: {} as SQL,
    dispatch: async () => {},
    secretProvider: inMemoryWebhookSecretProvider("s"),
    metrics: registry ?? new MetricsRegistry(),
    registry,
    lookupCallByBotId: async () => null,
    lookupCallByIngestSecret: async () => null,
  });
}

describe("ingest GET /metrics (issue #108, §5.11)", () => {
  it("mounts /metrics off the injected shared registry with exact Prometheus lines", async () => {
    const registry = new MetricsRegistry();
    const app = appWithRegistry(registry);

    // Drive the counter ports the SAME way the webhook/pipeline do — through the
    // shared registry instance the composition root injected.
    registry.incRejected("bad_signature");
    registry.incRejected("bad_signature");
    registry.incTranscriptLines("us-east");

    const res = await app(new Request("http://ingest.local/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);

    const body = await res.text();
    expect(body).toContain(`webhook_rejected_total{reason="bad_signature"} 2`);
    expect(body).toContain(`transcript_lines_total{region="us-east"} 1`);
    expect(body).toContain(`# TYPE bot_join_total counter`);
  });

  it("without an injected registry, /metrics falls through to 404 (unchanged)", async () => {
    const app = appWithRegistry(undefined);
    const res = await app(new Request("http://ingest.local/metrics"));
    expect(res.status).toBe(404);
  });

  it("the shared registry is a drop-in for the ingest dispatch counter ports", () => {
    // Compile-time + construct-time proof that ONE MetricsRegistry satisfies the
    // TranscriptMetrics + BotLifecycleMetrics ports (replacing the inMemory fakes).
    const registry = new MetricsRegistry();
    const dispatch = buildIngestDispatch({
      publisher: new InMemoryTranscriptPublisher(),
      worker: inMemoryBotWorker(),
      transcriptMetrics: registry,
      lifecycleMetrics: registry,
    });
    expect(typeof dispatch).toBe("function");
  });
});

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("ingest /metrics — a real webhook aggregates into the shared registry (#108)", () => {
  let sql: SQL;
  const fake = createRecallFake({ seed: `metrics-${randomUUID()}` });
  const userId = randomUUID();
  const tenantId = randomUUID();
  const callId = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@m.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
      VALUES (${callId}, ${tenantId}, 'https://meet.google.com/mx', 'IN_CALL', 'us-east',
              ${fake.botId}, ${sha256Hex(fake.ingestSecret)})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM webhook_events WHERE bot_id = ${fake.botId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.close();
  });

  it("a transcript webhook bumps transcript_lines_total{region} and /metrics scrapes it", async () => {
    const registry = new MetricsRegistry();
    const app = createIngestApp({
      sql,
      // ONE shared registry as BOTH the transcript counter AND the /metrics source.
      dispatch: buildIngestDispatch({
        publisher: new InMemoryTranscriptPublisher(),
        worker: inMemoryBotWorker(),
        transcriptMetrics: registry,
        lifecycleMetrics: registry,
      }),
      secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
      metrics: registry,
      registry,
      lookupCallByBotId: pgLookupCallByBotId(sql),
    });

    const env = fake.webhook(fake.transcriptData({ speaker: "Alice", words: ["hello", "world"] }));
    const u = new URL(env.url);
    const res = await app(
      new Request(`http://ingest.local${u.pathname}${u.search}`, {
        method: "POST",
        headers: env.headers,
        body: env.rawBody,
      }),
    );
    expect(res.status).toBe(200);

    // Exact aggregation into the SHARED registry (not a per-process fake).
    expect(registry.get("transcript_lines_total", "us-east")).toBe(1);

    const metrics = await (await app(new Request("http://ingest.local/metrics"))).text();
    expect(metrics).toContain(`transcript_lines_total{region="us-east"} 1`);
  });
});
