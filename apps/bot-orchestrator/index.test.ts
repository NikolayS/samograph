/**
 * Bot-orchestrator unit suite — no DB, no network (SPEC §6.1: the Recall fake is
 * the only client). Exercises the §5.2 createBot path: mint a per-call
 * `ingest_secret`, persist ONLY its SHA-256 hash, call createBot through a
 * swappable `RecallClient` backed by `packages/test-fakes/recall`, and flip
 * PENDING→JOINING. Exact-value assertions throughout.
 */
import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { createRecallFake, type RecallFake } from "../../packages/test-fakes/recall/index.ts";
import { MetricsRegistry } from "../../packages/shared/observe/registry.ts";
import { inMemoryBotJoinMetrics } from "./botJoinMetrics.ts";
import {
  BOT_NAME,
  DEFAULT_REGION,
  SERVICE_NAME,
  buildWebhookUrl,
  envSecretProvider,
  generateIngestSecret,
  ingestSecretHash,
  inMemorySecretProvider,
  orchestrateJoin,
  pickRegion,
  publicWebhookBase,
  regionTunnelBase,
  runJoinJob,
  sanitizeFailureReason,
  type CallStore,
  type CreateBotRequest,
  type RecallClient,
} from "./index.ts";

const CALL_ID = "11111111-1111-1111-1111-111111111111";
const MEETING_URL = "https://meet.google.com/abc-defg-hij";

/** A `RecallClient` backed by the deterministic Recall fake; captures the call. */
function fakeRecall(
  fake: RecallFake,
  capture?: (c: { req: CreateBotRequest; webhookUrl: string }) => void,
): RecallClient {
  return {
    async createBot(req: CreateBotRequest) {
      const { id } = fake.createBot();
      const webhookUrl = req.buildWebhookUrl(id);
      capture?.({ req, webhookUrl });
      return { id, webhookUrl };
    },
  };
}

interface RecordedCall {
  method: "recordIngestSecret" | "markJoining" | "markCouldNotJoin";
  args: string[];
}

/** In-memory `CallStore` that records every method + argument, in order. */
function memStore(order: string[] = []) {
  const recorded: RecordedCall[] = [];
  const store: CallStore = {
    async recordIngestSecret(callId, hash, region) {
      order.push("recordIngestSecret");
      recorded.push({ method: "recordIngestSecret", args: [callId, hash, region] });
    },
    async markJoining(callId, recallBotId) {
      order.push("markJoining");
      recorded.push({ method: "markJoining", args: [callId, recallBotId] });
    },
    async markCouldNotJoin(callId, reason) {
      order.push("markCouldNotJoin");
      recorded.push({ method: "markCouldNotJoin", args: [callId, reason] });
    },
  };
  return { store, recorded, order };
}

describe("bot-orchestrator service identity", () => {
  it("names itself bot-orchestrator and defaults to the single v1 region us-east (§4.7)", () => {
    expect(SERVICE_NAME).toBe("bot-orchestrator");
    expect(DEFAULT_REGION).toBe("us-east");
    expect(pickRegion()).toBe("us-east");
  });
});

describe("ingest_secret minting (§4.2)", () => {
  it("mints a high-entropy base64url secret (>=256 bits) that is unique per call", () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const s = generateIngestSecret();
      // 32 random bytes → 43-char unpadded base64url string (256 bits of entropy).
      expect(s).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      secrets.add(s);
    }
    // All 1000 distinct: no collisions, never a constant.
    expect(secrets.size).toBe(1000);
  });

  it("hashes a secret with SHA-256 hex — known vector, and never equals the plaintext", () => {
    // Exact, well-known SHA-256("test") vector pins the hash function precisely.
    expect(ingestSecretHash("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
    const secret = generateIngestSecret();
    const hash = ingestSecretHash(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(secret);
  });
});

describe("webhook URL shape (§5.2)", () => {
  it("resolves the region tunnel base and embeds ?bot=<id>&t=<secret>", () => {
    expect(regionTunnelBase("us-east")).toBe("https://us-east.tunnel.samograph.dev");
    expect(buildWebhookUrl("https://us-east.tunnel.samograph.dev", "bot_abc", "sek")).toBe(
      "https://us-east.tunnel.samograph.dev/webhook?bot=bot_abc&t=sek",
    );
  });
});

describe("configurable public webhook base (§5.2; issue #88 VM deploy)", () => {
  it("publicWebhookBase reads PUBLIC_WEBHOOK_BASE and returns its origin", () => {
    expect(publicWebhookBase({ PUBLIC_WEBHOOK_BASE: "https://samograph-main.samo.cat" })).toBe(
      "https://samograph-main.samo.cat",
    );
    // Trailing path/slash is normalized away to the origin.
    expect(publicWebhookBase({ PUBLIC_WEBHOOK_BASE: "https://h.example/ignored" })).toBe(
      "https://h.example",
    );
  });

  it("publicWebhookBase is undefined when unset (regional tunnel default applies)", () => {
    expect(publicWebhookBase({})).toBeUndefined();
  });

  it("publicWebhookBase rejects a non-https base with a clear error", () => {
    expect(() => publicWebhookBase({ PUBLIC_WEBHOOK_BASE: "http://insecure" })).toThrow(/https/);
    expect(() => publicWebhookBase({ PUBLIC_WEBHOOK_BASE: "not a url" })).toThrow(
      /PUBLIC_WEBHOOK_BASE/,
    );
  });

  it("orchestrateJoin builds the webhook URL against deps.webhookBase when provided", async () => {
    const fake = createRecallFake({ seed: CALL_ID });
    let captured: { req: CreateBotRequest; webhookUrl: string } | null = null;
    const { store } = memStore();
    const secret = "fixed-secret-for-webhookbase-test-00000000000";

    await orchestrateJoin(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      {
        recall: fakeRecall(fake, (c) => (captured = c)),
        store,
        generateSecret: () => secret,
        webhookBase: "https://samograph-main.samo.cat",
      },
    );

    const cap = captured as unknown as { webhookUrl: string };
    expect(cap.webhookUrl).toBe(
      `https://samograph-main.samo.cat/webhook?bot=${fake.botId}&t=${secret}`,
    );
  });
});

describe("orchestrateJoin — createBot path (§5.2, §5.3, §4.4)", () => {
  it("mints secret, persists ONLY the hash, calls createBot, flips PENDING→JOINING", async () => {
    const secret = "fixed-deterministic-ingest-secret-000000000";
    const fake = createRecallFake({ seed: CALL_ID });
    let captured: { req: CreateBotRequest; webhookUrl: string } | null = null;
    const { store, recorded, order } = memStore();

    const result = await orchestrateJoin(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      { recall: fakeRecall(fake, (c) => (captured = c)), store, generateSecret: () => secret },
    );

    const expectedHash = createHash("sha256").update(secret).digest("hex");

    // Result reports the JOINING transition + the Recall-assigned bot id.
    expect(result).toEqual({
      callId: CALL_ID,
      recallBotId: fake.botId,
      region: "us-east",
      status: "JOINING",
      ingestSecretHash: expectedHash,
    });

    // Persistence is hash-only: the stored value is the SHA-256, never the plaintext.
    expect(recorded[0]).toEqual({
      method: "recordIngestSecret",
      args: [CALL_ID, expectedHash, "us-east"],
    });
    expect(recorded[0].args[1]).not.toBe(secret);

    // createBot was called with the canonical webhook_url embedding ?bot=<id>&t=<secret>.
    expect(captured).not.toBeNull();
    const cap = captured as unknown as { req: CreateBotRequest; webhookUrl: string };
    expect(cap.req.meetingUrl).toBe(MEETING_URL);
    expect(cap.req.botName).toBe(BOT_NAME);
    expect(cap.webhookUrl).toBe(
      `https://us-east.tunnel.samograph.dev/webhook?bot=${fake.botId}&t=${secret}`,
    );
    expect(cap.webhookUrl).toContain(`?bot=${fake.botId}&t=${secret}`);

    // Ack → status flips to JOINING and records recall_bot_id (no workers row yet).
    expect(recorded[1]).toEqual({
      method: "markJoining",
      args: [CALL_ID, fake.botId],
    });

    // §5.2 ordering: store hash, THEN createBot, THEN mark JOINING.
    expect(order).toEqual(["recordIngestSecret", "markJoining"]);
  });

  it("never persists, returns, or logs the plaintext ingest_secret (§4.2)", async () => {
    const secret = generateIngestSecret();
    const fake = createRecallFake({ seed: CALL_ID });
    const { store, recorded } = memStore();
    const logs: string[] = [];

    const result = await orchestrateJoin(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      {
        recall: fakeRecall(fake),
        store,
        generateSecret: () => secret,
        logger: { info: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`) },
      },
    );

    // Never RETURNED: no result value carries the plaintext.
    expect(Object.values(result)).not.toContain(secret);
    // Never PERSISTED: no stored argument is the plaintext.
    const persisted = recorded.flatMap((r) => r.args);
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain(ingestSecretHash(secret)); // the hash IS persisted
    // Never LOGGED: progress IS logged, but the secret never appears in it.
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("mints a UNIQUE ingest_secret per call (two calls → two distinct hashes)", async () => {
    const fakeA = createRecallFake({ seed: "call-A" });
    const fakeB = createRecallFake({ seed: "call-B" });
    const a = memStore();
    const b = memStore();

    const resA = await orchestrateJoin(
      { callId: "call-A", meetingUrl: MEETING_URL },
      { recall: fakeRecall(fakeA), store: a.store },
    );
    const resB = await orchestrateJoin(
      { callId: "call-B", meetingUrl: MEETING_URL },
      { recall: fakeRecall(fakeB), store: b.store },
    );

    expect(resA.ingestSecretHash).not.toBe(resB.ingestSecretHash);
    expect(resA.ingestSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(resB.ingestSecretHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("shared Recall key boundary (§4.4)", () => {
  it("inMemorySecretProvider returns the configured key", async () => {
    expect(await inMemorySecretProvider("recall-key-xyz").recallApiKey()).toBe("recall-key-xyz");
  });

  it("envSecretProvider reads RECALL_API_KEY and throws cleanly when unset", async () => {
    const prev = process.env.RECALL_API_KEY;
    try {
      process.env.RECALL_API_KEY = "env-recall-key";
      expect(await envSecretProvider().recallApiKey()).toBe("env-recall-key");

      delete process.env.RECALL_API_KEY;
      await expect(envSecretProvider().recallApiKey()).rejects.toThrow(/RECALL_API_KEY/);
    } finally {
      if (prev === undefined) delete process.env.RECALL_API_KEY;
      else process.env.RECALL_API_KEY = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story-4 silent hang: a createBot/join FAILURE must persist COULD_NOT_JOIN +
// a sanitized status_reason — never leave the call PENDING forever (§5.2, §5.16).
// ─────────────────────────────────────────────────────────────────────────────
describe("sanitizeFailureReason (§5.16 reason, §4.4 key hygiene)", () => {
  it("returns the error message with whitespace collapsed", () => {
    expect(sanitizeFailureReason(new Error("recall.ai bot creation failed: 507\n  out of capacity"), [])).toBe(
      "recall.ai bot creation failed: 507 out of capacity",
    );
  });

  it("REDACTS every occurrence of a provided secret (the Recall API key never persists)", () => {
    const key = "sk-recall-test-0123456789abcdef";
    const err = new Error(`recall.ai bot creation failed: 401 {"detail":"bad token ${key}"} (key=${key})`);
    const reason = sanitizeFailureReason(err, [key]);
    expect(reason).not.toContain(key);
    expect(reason).toBe(
      'recall.ai bot creation failed: 401 {"detail":"bad token [redacted]"} (key=[redacted])',
    );
  });

  it("defense in depth: an `Authorization: Token …` value is redacted even when the secret list misses it", () => {
    const reason = sanitizeFailureReason(new Error("HTTP 401 sent Token abcdef0123456789 to recall"), []);
    expect(reason).not.toContain("abcdef0123456789");
    expect(reason).toContain("Token [redacted]");
  });

  it("stringifies non-Error throwables and falls back on an empty message", () => {
    expect(sanitizeFailureReason("recall exploded", [])).toBe("recall exploded");
    expect(sanitizeFailureReason(new Error(""), [])).toBe("bot could not be created");
    expect(sanitizeFailureReason(undefined, [])).toBe("bot could not be created");
  });

  it("truncates an oversized reason to 300 chars (ellipsis-terminated)", () => {
    const reason = sanitizeFailureReason(new Error("x".repeat(1000)), []);
    expect(reason.length).toBe(300);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("runJoinJob — join failure persists COULD_NOT_JOIN + reason (Story 4)", () => {
  const failingRecall = (message: string): RecallClient => ({
    async createBot() {
      throw new Error(message);
    },
  });

  it("on createBot failure marks the call COULD_NOT_JOIN with the sanitized reason", async () => {
    const { store, recorded } = memStore();
    const outcome = await runJoinJob(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      { recall: failingRecall("recall.ai bot creation failed: 507 out of capacity"), store, secrets: [] },
    );

    expect(outcome).toEqual({
      callId: CALL_ID,
      status: "COULD_NOT_JOIN",
      reason: "recall.ai bot creation failed: 507 out of capacity",
    });
    // The failure was PERSISTED (not just logged): the exact store write happened.
    expect(recorded.at(-1)).toEqual({
      method: "markCouldNotJoin",
      args: [CALL_ID, "recall.ai bot creation failed: 507 out of capacity"],
    });
  });

  it("the persisted reason never contains the Recall API key (§4.4)", async () => {
    const key = "sk-recall-live-9876543210fedcba";
    const { store, recorded } = memStore();
    await runJoinJob(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      { recall: failingRecall(`recall.ai bot creation failed: 401 key ${key} rejected`), store, secrets: [key] },
    );
    const persisted = recorded.at(-1);
    expect(persisted?.method).toBe("markCouldNotJoin");
    expect(persisted?.args[1]).not.toContain(key);
    expect(persisted?.args[1]).toContain("[redacted]");
  });

  it("on success it is exactly orchestrateJoin (JOINING; markCouldNotJoin untouched)", async () => {
    const fake = createRecallFake({ seed: CALL_ID });
    const { store, order } = memStore();
    const outcome = await runJoinJob(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      { recall: fakeRecall(fake), store, secrets: [] },
    );
    expect(outcome.status).toBe("JOINING");
    expect(order).toEqual(["recordIngestSecret", "markJoining"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.11 bot_join_total{result} producer (issue #107): the orchestrator emits the
// terminal join-outcome counter EXACTLY once per call, and never leaks the key.
// ─────────────────────────────────────────────────────────────────────────────
describe("runJoinJob — bot_join_total{could_not_join} producer (§5.11, issue #107)", () => {
  const failingRecall = (message: string): RecallClient => ({
    async createBot() {
      throw new Error(message);
    },
  });

  it("a failed join increments bot_join_total{could_not_join} EXACTLY once", async () => {
    const { store } = memStore();
    const metrics = inMemoryBotJoinMetrics();
    await runJoinJob(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      { recall: failingRecall("507 out of capacity"), store, secrets: [], metrics },
    );
    expect(metrics.get("could_not_join")).toBe(1);
    // Only the failure result moved — no phantom in_call / could_not_record.
    expect(metrics.get("in_call")).toBe(0);
    expect(metrics.get("could_not_record")).toBe(0);
  });

  it("a successful join does NOT touch bot_join_total (JOINING is not terminal)", async () => {
    const fake = createRecallFake({ seed: CALL_ID });
    const { store } = memStore();
    const metrics = inMemoryBotJoinMetrics();
    const outcome = await runJoinJob(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      { recall: fakeRecall(fake), store, secrets: [], metrics },
    );
    expect(outcome.status).toBe("JOINING");
    expect(metrics.get("could_not_join")).toBe(0);
    expect(metrics.counts.size).toBe(0);
  });

  it("the shared MetricsRegistry is a drop-in producer and renders the incremented line", async () => {
    const registry = new MetricsRegistry();
    const { store } = memStore();
    await runJoinJob(
      { callId: CALL_ID, meetingUrl: MEETING_URL },
      { recall: failingRecall("507 out of capacity"), store, secrets: [], metrics: registry },
    );
    expect(registry.get("bot_join_total", "could_not_join")).toBe(1);
    // Exposition (§5.11): the /metrics endpoint now shows a non-zero series.
    expect(registry.renderPrometheus()).toContain(
      'bot_join_total{result="could_not_join"} 1',
    );
  });
});
