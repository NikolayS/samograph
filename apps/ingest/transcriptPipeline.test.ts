/**
 * Ingest transcript pipeline — `handleTranscriptEvent` (SPEC §5.4, §5.2, §5.5,
 * §5.10, §5.11; issue #78). The literal join between Sprint-1's pure normalizer
 * (`normalizeTranscriptLine`, §6.2 #1 — reused, NOT reimplemented) and live
 * fan-out: validated event → canonical line → append-only `transcripts` row
 * with a monotonic `seq` → publish on the per-`call_id` channel.
 *
 * Pure cases (no DB): the normalizer-null no-op (asserts the handler never even
 * touches the tx), the canonical-line split, and the dispatch attribution seam.
 * The persistence cases need the real `transcripts`/`calls` tables + RLS and are
 * gated on DATABASE_URL (the Postgres-smoke job runs the whole suite). Every
 * case drives the deterministic in-repo Recall fake + the in-memory publisher
 * fake — no real Recall, no tokens (§6.1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import { normalizeTranscriptLine } from "../../packages/shared/transcript/index.ts";
import {
  InMemoryTranscriptPublisher,
} from "../../packages/shared/transcript/publisher.ts";
import { connect, setTenant } from "../../packages/shared/db/index.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import {
  createTranscriptPipeline,
  inMemoryTranscriptMetrics,
  splitCanonicalLine,
} from "./transcriptPipeline.ts";
import {
  createWebhookHandler,
  inMemoryWebhookMetrics,
  inMemoryWebhookSecretProvider,
  pgLookupCallByBotId,
  type ValidatedEvent,
  type WebhookHandlerDeps,
} from "./webhook.ts";

const REGION = "eu-central";

/** Build a tenant-scoped `transcript.data` ValidatedEvent straight from the fake. */
function transcriptEvent(
  callId: string,
  tenantId: string,
  botId: string,
  opts: { speaker?: string; words: string[]; at?: string },
): ValidatedEvent {
  return {
    kind: "transcript.data",
    botId,
    callId,
    tenantId,
    recallEventId: `evt-${randomUUID()}`,
    payload: createRecallFake({ seed: "pipeline" }).transcriptData(opts),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure cases — no Postgres, no tokens.
// ─────────────────────────────────────────────────────────────────────────────
describe("splitCanonicalLine — inverse of the normalizer format (§5.4)", () => {
  it("round-trips: [ts] speaker: text reconstructs byte-identically to the CLI line", () => {
    const fake = createRecallFake({ seed: "split" });
    const line = normalizeTranscriptLine(
      fake.transcriptData({ speaker: "Alice", words: ["hello", "world"], at: "2026-01-01T00:01:30.000Z" }),
    )!;
    expect(line).toBe("[2026-01-01 00:01:30] Alice: hello world");

    const parts = splitCanonicalLine(line);
    expect(parts).toEqual({ ts: "2026-01-01 00:01:30", speaker: "Alice", text: "hello world" });
    // Reconstruction is byte-identical to the normalizer (single source of truth).
    expect(`[${parts.ts}] ${parts.speaker}: ${parts.text}`).toBe(line);
  });

  it("splits on the FIRST ': ' so utterances may contain colons", () => {
    expect(splitCanonicalLine("[2026-01-01 00:01:30] Bob: ratio is 3: 1")).toEqual({
      ts: "2026-01-01 00:01:30",
      speaker: "Bob",
      text: "ratio is 3: 1",
    });
  });

  it("handles an empty utterance", () => {
    expect(splitCanonicalLine("[2026-01-01 00:01:30] Bob: ")).toEqual({
      ts: "2026-01-01 00:01:30",
      speaker: "Bob",
      text: "",
    });
  });
});

describe("handleTranscriptEvent — normalizer-null no-op (TDD #4, partial)", () => {
  // A tx proxy that fails the test if ANY DB work is attempted: proves the
  // no-op path returns before touching the database (mirrors webhook's gate).
  const FORBIDDEN_TX = new Proxy(function () {}, {
    get() {
      throw new Error("no-op path must not touch the database");
    },
    apply() {
      throw new Error("no-op path must not touch the database");
    },
  }) as unknown as SQL;

  it("a non-transcript (bot.status_change) event writes no row, publishes nothing, counts nothing", async () => {
    const fake = createRecallFake({ seed: "noop" });
    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryTranscriptMetrics();
    const pipeline = createTranscriptPipeline({ publisher, metrics });

    const statusEvent: ValidatedEvent = {
      kind: "bot.status_change",
      botId: fake.botId,
      callId: randomUUID(),
      tenantId: randomUUID(),
      recallEventId: "evt-status",
      payload: fake.lifecycle("in_call_recording"),
    };
    await pipeline.handleTranscriptEvent(FORBIDDEN_TX, statusEvent);

    expect(publisher.published).toHaveLength(0);
    expect(metrics.lines).toEqual({});
  });

  it("an empty-words transcript payload (normalizer → null) is a no-op", async () => {
    const fake = createRecallFake({ seed: "noop2" });
    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryTranscriptMetrics();
    const pipeline = createTranscriptPipeline({ publisher, metrics });

    // Normalizer returns null for empty words[] — assert we rely on that.
    const payload = fake.transcriptData({ speaker: "Alice", words: [] });
    expect(normalizeTranscriptLine(payload)).toBeNull();

    await pipeline.handleTranscriptEvent(FORBIDDEN_TX, {
      kind: "transcript.data",
      botId: fake.botId,
      callId: randomUUID(),
      tenantId: randomUUID(),
      recallEventId: "evt-empty",
      payload,
    });

    expect(publisher.published).toHaveLength(0);
    expect(metrics.lines).toEqual({});
  });

  it("dispatch attribution: only transcript.data reaches the handler (the #93 reviewer's test)", async () => {
    // The webhook dispatches BOTH transcript.data and bot.status_change on the
    // same seam; the transcript pipeline's `dispatch` must act ONLY on
    // transcript.data and leave status events for the lifecycle issue (#79).
    const fake = createRecallFake({ seed: "attr" });
    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryTranscriptMetrics();
    const pipeline = createTranscriptPipeline({ publisher, metrics });

    // A bot.status_change must NOT touch the DB via this pipeline's dispatch.
    await pipeline.dispatch(FORBIDDEN_TX, {
      kind: "bot.status_change",
      botId: fake.botId,
      callId: randomUUID(),
      tenantId: randomUUID(),
      recallEventId: "evt-attr-status",
      payload: fake.lifecycle("in_call_recording"),
    });
    expect(publisher.published).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistence cases — need the real transcripts/calls tables + RLS (§5.10).
// ─────────────────────────────────────────────────────────────────────────────
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("handleTranscriptEvent persistence (§5.4/§5.2/§5.5/§5.11, TDD #1-#7)", () => {
  let sql: ReturnType<typeof connect>;
  const fake = createRecallFake({ seed: "pipeline-db" });

  // Two isolated tenants/calls so cross-call isolation is provable.
  const userA = randomUUID();
  const tenantA = randomUUID();
  const callA = randomUUID();
  const userB = randomUUID();
  const tenantB = randomUUID();
  const callB = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/a', 'IN_CALL', ${REGION}, ${fake.botId}, 'x'),
      (${callB}, ${tenantB}, 'https://meet.google.com/b', 'IN_CALL', ${REGION}, ${`${fake.botId}-b`}, 'y')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM calls WHERE id IN (${callA}, ${callB})`;
    await sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  beforeEach(async () => {
    // Each test starts from a clean transcript history + unset first_line_at.
    await sql`DELETE FROM transcripts WHERE call_id IN (${callA}, ${callB})`;
    await sql`UPDATE calls SET first_line_at = NULL WHERE id IN (${callA}, ${callB})`;
  });

  /** Run one validated event through the handler under the call's RLS context. */
  async function deliver(
    pipeline: ReturnType<typeof createTranscriptPipeline>,
    tenantId: string,
    event: ValidatedEvent,
  ): Promise<void> {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      await pipeline.handleTranscriptEvent(tx, event);
    });
  }

  it("#1 one transcript.data event → exactly one row; text = normalizer utterance, byte-identical to CLI", async () => {
    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryTranscriptMetrics();
    const pipeline = createTranscriptPipeline({ publisher, metrics });

    const event = transcriptEvent(callA, tenantA, fake.botId, {
      speaker: "Alice",
      words: ["hello", "world"],
      at: "2026-01-01T00:01:30.000Z",
    });
    await deliver(pipeline, tenantA, event);

    const rows = await sql`SELECT seq, speaker, text, ts FROM transcripts WHERE call_id = ${callA}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].seq)).toBe(1);
    expect(rows[0].speaker).toBe("Alice");
    // text is the UTTERANCE only (the canonical TranscriptLine shape, §5.4/§5.10).
    expect(rows[0].text).toBe("hello world");

    // The published frame, re-rendered, is byte-identical to the CLI normalizer.
    const frame = publisher.linesFor(callA)[0];
    expect(frame).toEqual({
      type: "line",
      call_id: callA,
      seq: 1,
      ts: "2026-01-01 00:01:30",
      speaker: "Alice",
      text: "hello world",
    });
    expect(`[${frame.ts}] ${frame.speaker}: ${frame.text}`).toBe(
      normalizeTranscriptLine(event.payload)!,
    );
  });

  it("#2 seq is strictly monotonic per call and isolated across calls", async () => {
    const publisher = new InMemoryTranscriptPublisher();
    const pipeline = createTranscriptPipeline({ publisher, metrics: inMemoryTranscriptMetrics() });

    // Interleave A and B deliveries: each call gets its own 1..n sequence.
    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: ["a1"] }));
    await deliver(pipeline, tenantB, transcriptEvent(callB, tenantB, `${fake.botId}-b`, { words: ["b1"] }));
    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: ["a2"] }));
    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: ["a3"] }));
    await deliver(pipeline, tenantB, transcriptEvent(callB, tenantB, `${fake.botId}-b`, { words: ["b2"] }));

    const seqA = (await sql`SELECT seq FROM transcripts WHERE call_id = ${callA} ORDER BY seq`).map(
      (r: { seq: bigint }) => Number(r.seq),
    );
    const seqB = (await sql`SELECT seq FROM transcripts WHERE call_id = ${callB} ORDER BY seq`).map(
      (r: { seq: bigint }) => Number(r.seq),
    );
    expect(seqA).toEqual([1, 2, 3]);
    expect(seqB).toEqual([1, 2]);
  });

  it("#3 a re-delivered (webhook-deduped) event produces NO second row — at-most-once end-to-end", async () => {
    // End-to-end through the §93 front door: the dedup ledger makes a Recall
    // re-delivery a no-op, so the pipeline never double-appends.
    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryTranscriptMetrics();
    const pipeline = createTranscriptPipeline({ publisher, metrics });

    const handler = createWebhookHandler({
      secretProvider: inMemoryWebhookSecretProvider(fake.webhookSecret),
      lookupCallByBotId: pgLookupCallByBotId(sql),
      sql,
      dispatch: pipeline.dispatch,
      metrics: inMemoryWebhookMetrics(),
    } satisfies WebhookHandlerDeps);

    // The call row must carry the fake's real ingest_secret_hash for §5.3 step 3.
    const { createHash } = await import("node:crypto");
    await sql`UPDATE calls SET ingest_secret_hash = ${createHash("sha256").update(fake.ingestSecret).digest("hex")} WHERE id = ${callA}`;
    await sql`DELETE FROM webhook_events WHERE bot_id = ${fake.botId}`;

    const env = fake.webhook(fake.transcriptData({ speaker: "Alice", words: ["hi"] }));
    const redelivery = fake.replay(env);
    const first = await handler(new Request(env.url, { method: "POST", headers: env.headers, body: env.rawBody }));
    const second = await handler(
      new Request(redelivery.url, { method: "POST", headers: redelivery.headers, body: redelivery.rawBody }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const count = await sql`SELECT count(*)::int AS c FROM transcripts WHERE call_id = ${callA}`;
    expect(count[0].c).toBe(1);
    // Published exactly once too (the second delivery never reaches dispatch).
    expect(publisher.linesFor(callA)).toHaveLength(1);

    await sql`DELETE FROM webhook_events WHERE bot_id = ${fake.botId}`;
    await sql`UPDATE calls SET ingest_secret_hash = 'x' WHERE id = ${callA}`;
  });

  it("#4 non-transcript / empty-words payload writes no row and publishes nothing", async () => {
    const publisher = new InMemoryTranscriptPublisher();
    const metrics = inMemoryTranscriptMetrics();
    const pipeline = createTranscriptPipeline({ publisher, metrics });

    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { speaker: "Alice", words: [] }));

    const count = await sql`SELECT count(*)::int AS c FROM transcripts WHERE call_id = ${callA}`;
    expect(count[0].c).toBe(0);
    expect(publisher.published).toHaveLength(0);
    expect(metrics.lines).toEqual({});
  });

  it("#5 first line sets calls.first_line_at once, never overwrites; status untouched", async () => {
    const pipeline = createTranscriptPipeline({
      publisher: new InMemoryTranscriptPublisher(),
      metrics: inMemoryTranscriptMetrics(),
    });

    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, {
      words: ["first"], at: "2026-01-01T00:01:30.000Z",
    }));
    const afterFirst = await sql`SELECT first_line_at, status FROM calls WHERE id = ${callA}`;
    expect(afterFirst[0].first_line_at).not.toBeNull();
    expect(afterFirst[0].status).toBe("IN_CALL");
    const firstAt = afterFirst[0].first_line_at;

    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, {
      words: ["second"], at: "2026-01-01T00:09:59.000Z",
    }));
    const afterSecond = await sql`SELECT first_line_at, status FROM calls WHERE id = ${callA}`;
    // Never overwritten by the later line, and status stays exactly as it was.
    expect(afterSecond[0].first_line_at).toEqual(firstAt);
    expect(afterSecond[0].status).toBe("IN_CALL");
  });

  it("#6 every persisted line is published once on its channel; call B never sees call A", async () => {
    const publisher = new InMemoryTranscriptPublisher();
    const pipeline = createTranscriptPipeline({ publisher, metrics: inMemoryTranscriptMetrics() });

    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: ["a1"] }));
    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: ["a2"] }));
    await deliver(pipeline, tenantB, transcriptEvent(callB, tenantB, `${fake.botId}-b`, { words: ["b1"] }));

    expect(publisher.linesFor(callA).map((f) => f.seq)).toEqual([1, 2]);
    expect(publisher.linesFor(callB).map((f) => f.seq)).toEqual([1]);
    expect(publisher.framesFor(callB).every((f) => f.call_id === callB)).toBe(true);
    // One publish per persisted row, no duplicates.
    expect(publisher.published).toHaveLength(3);
  });

  it("#7 transcript_lines_total{region} increments once per persisted line", async () => {
    const metrics = inMemoryTranscriptMetrics();
    const pipeline = createTranscriptPipeline({ publisher: new InMemoryTranscriptPublisher(), metrics });

    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: ["a1"] }));
    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: ["a2"] }));
    await deliver(pipeline, tenantB, transcriptEvent(callB, tenantB, `${fake.botId}-b`, { words: ["b1"] }));

    // Both calls are in the same region; the counter is region-labelled (§5.11).
    expect(metrics.lines).toEqual({ [REGION]: 3 });
    // An empty payload (no row) does NOT increment the counter.
    await deliver(pipeline, tenantA, transcriptEvent(callA, tenantA, fake.botId, { words: [] }));
    expect(metrics.lines).toEqual({ [REGION]: 3 });
  });
});
