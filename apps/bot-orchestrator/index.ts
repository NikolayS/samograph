/**
 * @samograph/bot-orchestrator — the call-creation seam (SPEC §4.1, §4.4, §5.2).
 *
 * Given an enqueued job `(call_id, meeting_url)`, the orchestrator:
 *   1. picks the region (single `us-east` in v1, §4.7),
 *   2. mints a per-call `ingest_secret` and persists ONLY its SHA-256 hash on
 *      `calls.ingest_secret_hash` (§4.2 — the plaintext is never persisted,
 *      returned, or logged),
 *   3. creates the Recall bot through a swappable {@link RecallClient} port
 *      (backed by the deterministic in-repo fake in tests, §6.1) with
 *      `webhook_url = https://<region-tunnel>/webhook?bot=<bot_id>&t=<ingest_secret>`,
 *   4. on Recall ack flips the call PENDING→JOINING and records `recall_bot_id`.
 *
 * The shared Recall API key boundary (§4.4) lives here as the {@link SecretProvider}
 * abstraction (env / secret-manager placeholder); it is never exposed elsewhere.
 * Inbound webhook verification + the normalizer (§5.3), worker registration
 * (§6.2 #9), the real tunnel, and real-Recall wiring are deliberately OUT of scope.
 */
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../packages/shared/crypto.ts";
import type { SQL } from "bun";

/** This service's stable name (parity with the other workspace stubs). */
export const SERVICE_NAME = "bot-orchestrator";

/** The single production region in v1 (§4.7); multi-region is not a launch gate. */
export const DEFAULT_REGION = "us-east";

/** Recognizable bot identity shown in the call (§3 / §5.9). */
export const BOT_NAME = "samograph (recording)";

/** The enqueued unit of work app-api hands the orchestrator (§5.2). */
export interface OrchestratorJob {
  callId: string;
  meetingUrl: string;
}

/**
 * Per-call create request handed to the Recall client. `buildWebhookUrl` weaves
 * Recall's assigned `bot_id` into the final per-call webhook URL once it is
 * known (`…/webhook?bot=<id>&t=<ingest_secret>`, §5.2).
 */
export interface CreateBotRequest {
  meetingUrl: string;
  botName: string;
  buildWebhookUrl: (recallBotId: string) => string;
}

export interface CreatedBot {
  /** Recall-assigned bot id (stable + deterministic from the fake in tests). */
  id: string;
  /** The finalized per-call webhook URL embedding `?bot=<id>&t=<secret>`. */
  webhookUrl: string;
}

/**
 * Swappable Recall client port — mirrors the `createBot` shape of `src/recall.ts`,
 * narrowed to the orchestrator's create path. Backed by `packages/test-fakes/recall`
 * in tests (the only client exercised on a PR, §6.1); the real-Recall binding
 * (reusing `src/recall.ts` + the shared key) is wired with the live tunnel later.
 */
export interface RecallClient {
  createBot(req: CreateBotRequest): Promise<CreatedBot>;
}

/**
 * Persistence port for the two `calls`-row writes the orchestrator performs.
 * Kept abstract so the core is unit-testable without a database; the Postgres
 * implementation is {@link pgCallStore}.
 */
export interface CallStore {
  /** Persist ONLY the SHA-256 hash of the ingest_secret (+ region); status stays PENDING. */
  recordIngestSecret(callId: string, ingestSecretHash: string, region: string): Promise<void>;
  /** On Recall ack: flip PENDING→JOINING and record `recall_bot_id` (§5.2). */
  markJoining(callId: string, recallBotId: string): Promise<void>;
  /**
   * On a createBot/join FAILURE: flip the (non-terminal) call to terminal
   * `COULD_NOT_JOIN` and persist the sanitized failure reason on
   * `calls.status_reason` (§5.2, §5.16, Story 4) — never leave it PENDING.
   * Forward-only: a row already terminal is untouched.
   */
  markCouldNotJoin(callId: string, reason: string): Promise<void>;
}

/** Minimal structured logger; the orchestrator NEVER logs the secret or the key. */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
}

export interface OrchestrateDeps {
  recall: RecallClient;
  store: CallStore;
  /** Region override; defaults to {@link pickRegion}. */
  region?: string;
  /**
   * Public webhook base override (§5.3). When set (e.g. from `PUBLIC_WEBHOOK_BASE`,
   * see {@link publicWebhookBase}), the per-call webhook URL is built against this
   * origin instead of the region's tunnel base — the seam that lets a real bot on a
   * public VM reach an operator-controlled ingress. Defaults to {@link regionTunnelBase}.
   */
  webhookBase?: string;
  /** Secret generator override (deterministic in tests); defaults to {@link generateIngestSecret}. */
  generateSecret?: () => string;
  logger?: Logger;
}

export interface OrchestrateResult {
  callId: string;
  recallBotId: string;
  region: string;
  status: "JOINING";
  /** SHA-256 hash that was persisted — never the plaintext. */
  ingestSecretHash: string;
}

/**
 * The shared Recall API key boundary (§4.4). The key concept lives ONLY in the
 * orchestrator/ingest processes via this abstraction (env in dev, secret manager
 * in prod). It is never returned by any API, never logged, never handed to the
 * agent channel.
 */
export interface SecretProvider {
  recallApiKey(): Promise<string>;
}

const noopLogger: Logger = { info() {} };

/** Persistent regional cloudflared named-tunnel bases, keyed by region (§4.3, §4.7). */
const REGION_TUNNEL_BASES: Record<string, string> = {
  "us-east": "https://us-east.tunnel.samograph.dev",
};

/** v1 region selection: always the single `us-east` region (§4.7). */
export function pickRegion(): string {
  return DEFAULT_REGION;
}

/**
 * Mint a per-call ingest_secret: 32 cryptographically-random bytes (256 bits)
 * as an unpadded base64url string (43 chars, URL-safe so it rides cleanly in the
 * webhook query string). Unique per call (§4.2, §5.2).
 */
export function generateIngestSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 (hex) of the ingest_secret — the only form ever persisted (§4.2). */
export function ingestSecretHash(secret: string): string {
  return sha256Hex(secret);
}

/** The persistent regional tunnel base for a region; throws on an unknown region. */
export function regionTunnelBase(region: string): string {
  const base = REGION_TUNNEL_BASES[region];
  if (!base) throw new Error(`no tunnel base configured for region: ${region}`);
  return base;
}

/**
 * The operator-configured public webhook base (§5.3), read from `PUBLIC_WEBHOOK_BASE`
 * (e.g. `https://samograph-main.samo.cat`). Returns the bare origin (path/trailing
 * slash stripped), or `undefined` when unset (the region's tunnel base applies).
 * A set-but-malformed or non-https value throws a clear error — a real bot must not
 * silently register an unreachable/insecure webhook destination.
 */
export function publicWebhookBase(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = (env.PUBLIC_WEBHOOK_BASE ?? "").trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_WEBHOOK_BASE is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`PUBLIC_WEBHOOK_BASE must be an https:// URL (got ${parsed.protocol}//…)`);
  }
  return parsed.origin;
}

/** Build the per-call webhook URL: `<base>/webhook?bot=<id>&t=<ingest_secret>` (§5.2). */
export function buildWebhookUrl(base: string, recallBotId: string, ingestSecret: string): string {
  const q = new URLSearchParams({ bot: recallBotId, t: ingestSecret });
  return `${base}/webhook?${q.toString()}`;
}

/**
 * Drive one enqueued call through the §5.2 createBot path. Order is exactly:
 * persist hash → createBot → mark JOINING.
 */
export async function orchestrateJoin(
  job: OrchestratorJob,
  deps: OrchestrateDeps,
): Promise<OrchestrateResult> {
  const region = deps.region ?? pickRegion();
  const logger = deps.logger ?? noopLogger;
  const generate = deps.generateSecret ?? generateIngestSecret;

  // Mint the per-call secret and derive its hash. The plaintext stays in this
  // function: it is used ONLY to build the webhook URL handed to Recall, then
  // discarded — it is never persisted, returned, or logged (§4.2).
  const ingestSecret = generate();
  const hash = ingestSecretHash(ingestSecret);
  logger.info("orchestrate.start", { callId: job.callId, region });

  // 1) Persist ONLY the hash (+ region). Status stays PENDING (§5.2).
  await deps.store.recordIngestSecret(job.callId, hash, region);

  // 2) Create the Recall bot; finalize the webhook URL with the assigned bot id.
  //    A `webhookBase` override (PUBLIC_WEBHOOK_BASE) wins over the regional tunnel
  //    base so a real bot on a public VM can reach an operator-controlled ingress.
  const base = deps.webhookBase ?? regionTunnelBase(region);
  const created = await deps.recall.createBot({
    meetingUrl: job.meetingUrl,
    botName: BOT_NAME,
    buildWebhookUrl: (recallBotId) => buildWebhookUrl(base, recallBotId, ingestSecret),
  });
  logger.info("orchestrate.bot_created", {
    callId: job.callId,
    recallBotId: created.id,
    region,
  });

  // 3) Recall ack → PENDING→JOINING + record recall_bot_id (no workers row yet).
  await deps.store.markJoining(job.callId, created.id);
  logger.info("orchestrate.joining", { callId: job.callId, recallBotId: created.id });

  return {
    callId: job.callId,
    recallBotId: created.id,
    region,
    status: "JOINING",
    ingestSecretHash: hash,
  };
}

/** Cap for a persisted `status_reason` (§5.16 detail is a short human string). */
const MAX_REASON_LENGTH = 300;

/** Fallback reason when the thrown value carries no usable message. */
const UNKNOWN_JOIN_FAILURE_REASON = "bot could not be created";

/**
 * Turn a createBot/join failure into a persistable `status_reason` (§5.16):
 * the error message with whitespace collapsed, every provided secret REDACTED
 * (the Recall API key must never reach the database/UI — §4.4), any
 * `Token <value>` credential redacted as defense in depth, and the result
 * capped at {@link MAX_REASON_LENGTH} chars. Never returns an empty string.
 */
export function sanitizeFailureReason(
  err: unknown,
  secrets: readonly (string | undefined)[] = [process.env.RECALL_API_KEY],
): string {
  let reason = err instanceof Error ? err.message : err === undefined || err === null ? "" : String(err);
  for (const candidate of secrets) {
    const secret = (candidate ?? "").trim();
    // Ignore trivial values that would shred unrelated text if "redacted".
    if (secret.length >= 4) reason = reason.split(secret).join("[redacted]");
  }
  // Defense in depth: an HTTP client error echoing an Authorization header.
  reason = reason.replace(/\bToken\s+[A-Za-z0-9._-]{8,}/g, "Token [redacted]");
  reason = reason.replace(/\s+/g, " ").trim();
  if (!reason) return UNKNOWN_JOIN_FAILURE_REASON;
  if (reason.length > MAX_REASON_LENGTH) {
    reason = `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
  }
  return reason;
}

/** The terminal outcome {@link runJoinJob} reports for a failed join (Story 4). */
export interface JoinFailure {
  callId: string;
  status: "COULD_NOT_JOIN";
  /** The sanitized §5.16 reason that was persisted on `calls.status_reason`. */
  reason: string;
}

export type JoinOutcome = OrchestrateResult | JoinFailure;

/**
 * Drive one enqueued call through {@link orchestrateJoin}, converting a FAILURE
 * into a persisted terminal state instead of a silent PENDING hang (Story 4,
 * §5.2, §5.16): on any throw, the call is marked `COULD_NOT_JOIN` with the
 * sanitized reason on `calls.status_reason`. Runs on the orchestrator's
 * privileged connection (an infra write that bypasses RLS, like the other
 * `UPDATE calls` here). Secrets for redaction are injectable; they default to
 * the shared Recall API key (§4.4).
 */
export async function runJoinJob(
  job: OrchestratorJob,
  deps: OrchestrateDeps & { secrets?: readonly (string | undefined)[] },
): Promise<JoinOutcome> {
  const logger = deps.logger ?? noopLogger;
  try {
    return await orchestrateJoin(job, deps);
  } catch (err) {
    const reason = sanitizeFailureReason(err, deps.secrets);
    // The reason is already sanitized — safe to log (never raw `err`, which
    // could echo the Authorization header on an HTTP failure).
    logger.info("orchestrate.join_failed", { callId: job.callId, reason });
    await deps.store.markCouldNotJoin(job.callId, reason);
    return { callId: job.callId, status: "COULD_NOT_JOIN", reason };
  }
}

/**
 * Postgres-backed {@link CallStore} over `@samograph/shared/db`. Three narrow
 * writes against the existing `calls` row (created PENDING by app-api, §5.2).
 */
export function pgCallStore(sql: SQL): CallStore {
  return {
    async recordIngestSecret(callId, ingestSecretHash, region) {
      await sql`
        UPDATE calls
           SET ingest_secret_hash = ${ingestSecretHash},
               region = ${region}
         WHERE id = ${callId}`;
    },
    async markJoining(callId, recallBotId) {
      await sql`
        UPDATE calls
           SET status = 'JOINING',
               recall_bot_id = ${recallBotId}
         WHERE id = ${callId}`;
    },
    async markCouldNotJoin(callId, reason) {
      // Forward-only (mirrors the status poller's conditional UPDATE): only a
      // non-terminal call can fail to join; a terminal row is never regressed
      // or relabeled. Stamps ended_at, keeps any earlier reason (COALESCE).
      await sql`
        UPDATE calls
           SET status = 'COULD_NOT_JOIN',
               ended_at = COALESCE(ended_at, now()),
               status_reason = COALESCE(status_reason, ${reason})
         WHERE id = ${callId}
           AND status IN ('PENDING', 'JOINING', 'IN_CALL')`;
    },
  };
}

/**
 * Reads the shared Recall API key from the environment (the v1 secret-manager
 * placeholder, §4.4 / §4.10). The key never leaves this module boundary.
 */
export function envSecretProvider(): SecretProvider {
  return {
    async recallApiKey() {
      const key = process.env.RECALL_API_KEY ?? "";
      if (!key) throw new Error("RECALL_API_KEY is not set");
      return key;
    },
  };
}

/** In-memory {@link SecretProvider} for tests / local dev. */
export function inMemorySecretProvider(key: string): SecretProvider {
  return {
    async recallApiKey() {
      return key;
    },
  };
}
