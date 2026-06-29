/**
 * Bot-orchestrator Postgres-store integration tests — run against the CI
 * ephemeral Postgres (real migrations + real schema, no mocks; SPEC §6.1),
 * skipped when DATABASE_URL is unset. Proves the §5.2 createBot path persists
 * ONLY the SHA-256 of the ingest_secret on `calls.ingest_secret_hash`, records
 * `recall_bot_id`, and flips PENDING→JOINING — end to end through the real
 * `pgCallStore` + the deterministic Recall fake.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "../../packages/shared/db/index.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createRecallFake, type RecallFake } from "../../packages/test-fakes/recall/index.ts";
import { orchestrateJoin, pgCallStore, type RecallClient, type CreateBotRequest } from "./index.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

function fakeRecall(fake: RecallFake): RecallClient {
  return {
    async createBot(req: CreateBotRequest) {
      const { id } = fake.createBot();
      return { id, webhookUrl: req.buildWebhookUrl(id) };
    },
  };
}

d("bot-orchestrator pgCallStore (§5.2, §4.2)", () => {
  let sql: ReturnType<typeof connect>;
  const userId = randomUUID();
  const tenantId = randomUUID();
  const callId = randomUUID();
  const MEETING_URL = "https://meet.google.com/orchestrator-itest";

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@orch.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    // App-api creates the Call as PENDING with no bot / secret yet (§5.2).
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status)
              VALUES (${callId}, ${tenantId}, ${MEETING_URL}, 'PENDING')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM calls WHERE id = ${callId}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.close();
  });

  it("persists hash-only, records recall_bot_id, and flips PENDING→JOINING", async () => {
    const secret = "itest-ingest-secret-deterministic-value-001";
    const expectedHash = createHash("sha256").update(secret).digest("hex");
    const fake = createRecallFake({ seed: callId });

    const before = await sql`SELECT status, ingest_secret_hash, recall_bot_id, region FROM calls WHERE id = ${callId}`;
    expect(before[0].status).toBe("PENDING");
    expect(before[0].ingest_secret_hash).toBeNull();
    expect(before[0].recall_bot_id).toBeNull();

    const result = await orchestrateJoin(
      { callId, meetingUrl: MEETING_URL },
      { recall: fakeRecall(fake), store: pgCallStore(sql), generateSecret: () => secret },
    );

    expect(result.status).toBe("JOINING");
    expect(result.recallBotId).toBe(fake.botId);
    expect(result.ingestSecretHash).toBe(expectedHash);

    const row = await sql`SELECT status, ingest_secret_hash, recall_bot_id, region, meeting_url FROM calls WHERE id = ${callId}`;
    expect(row[0].status).toBe("JOINING");
    expect(row[0].ingest_secret_hash).toBe(expectedHash);
    expect(row[0].recall_bot_id).toBe(fake.botId);
    expect(row[0].region).toBe("us-east");

    // The plaintext ingest_secret is NOWHERE in the persisted row (only the hash).
    const persistedText = Object.values(row[0]).map((v) => String(v));
    expect(persistedText).not.toContain(secret);
    expect(persistedText).toContain(expectedHash);
  });
});
