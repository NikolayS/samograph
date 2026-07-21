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
import { perEnvBaseUrl } from "../../packages/shared/config/env.ts";
import type { SQL } from "bun";
import type { BotJoinMetrics } from "./botJoinMetrics.ts";

/** This service's stable name (parity with the other workspace stubs). */
export const SERVICE_NAME = "bot-orchestrator";

/** The single production region in v1 (§4.7); multi-region is not a launch gate. */
export const DEFAULT_REGION = "us-east";

/**
 * Health + latency snapshot for one region candidate the §4.7 policy chooses
 * from. `healthy=false` (degraded) means the region FAILS CLOSED for new calls:
 * {@link pickRegion} skips it. `latencyMs` is the orchestrator-host→region probe
 * latency used to rank healthy candidates.
 */
export interface RegionHealth {
  region: string;
  healthy: boolean;
  latencyMs: number;
}

/**
 * The default region set: the single healthy `us-east` region. Until a 2nd region
 * is DEPLOYED (Sprint-3 deploy is deferred post-launch), this keeps production
 * behavior UNCHANGED — {@link pickRegion} with no config resolves to `us-east`.
 */
export const DEFAULT_REGIONS: readonly RegionHealth[] = [
  { region: DEFAULT_REGION, healthy: true, latencyMs: 0 },
];

/** Recognizable bot identity shown in the call (§3 / §5.9). */
export const BOT_NAME = "samograph (recording)";

/** The enqueued unit of work app-api hands the orchestrator (§5.2). */
export interface OrchestratorJob {
  callId: string;
  meetingUrl: string;
  /**
   * The tenant's EFFECTIVE Deepgram keyterms for this call (§5.12): the resolved
   * dictionary preset ∪ user terms. Absent ⇒ no keyterm prompting (the pre-settings
   * default). app-api resolves this from the tenant's saved settings at create time.
   */
  keyterms?: string[];
  /**
   * The tenant's transcription language (§5.12): a specific Deepgram code or
   * `multi` (multilingual auto-detect). Absent ⇒ `multi` (the pre-settings default).
   */
  language?: string;
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
  /** Per-tenant Deepgram keyterms (§5.12). Omitted ⇒ no keyterm prompting. */
  keyterms?: string[];
  /** Per-tenant Deepgram language (§5.12). Omitted ⇒ `multi` (auto-detect). */
  language?: string;
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
  /**
   * Explicit region HARD override. When set it wins outright (operator/testing
   * escape hatch) — the §4.7 policy is not consulted. When absent the region is
   * chosen by {@link pickRegion} over {@link regions}/{@link pinnedRegion}.
   */
  region?: string;
  /** §4.7 candidate region set for {@link pickRegion}; defaults to {@link DEFAULT_REGIONS}. */
  regions?: readonly RegionHealth[];
  /** §4.7(a) user-pinned region preference fed to {@link pickRegion}. */
  pinnedRegion?: string;
  /** Deterministic round-robin cursor for a §4.7 latency tie. */
  regionTieBreaker?: number;
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
  /**
   * §5.11 `bot_join_total{result}` producer (issue #107). {@link runJoinJob}
   * increments `could_not_join` EXACTLY once when a createBot/join FAILURE is
   * persisted as terminal COULD_NOT_JOIN. Carries only the coarse outcome label —
   * never the Recall key (§4.4). Omit ⇒ no metric (the counter stays at 0).
   */
  metrics?: BotJoinMetrics;
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

/**
 * Options for the §4.7 region-selection policy. All fields are injectable so the
 * policy is unit-testable and sourced from config/env/deps; every field defaults
 * so a bare `pickRegion()` resolves to the single `us-east` region (prod path).
 */
export interface PickRegionOptions {
  /** Candidate regions with health+latency; defaults to {@link DEFAULT_REGIONS}. */
  regions?: readonly RegionHealth[];
  /** §4.7(a) user-pinned override; honored only when that region is healthy. */
  pinned?: string;
  /**
   * Deterministic round-robin cursor for a latency TIE among healthy regions.
   * The tied set is ordered by region name; the chosen index is
   * `tieBreaker mod tieCount`. Same input ⇒ same output (no global state).
   */
  tieBreaker?: number;
  logger?: Logger;
}

/**
 * §4.7 region-selection policy. Given a CONFIGURABLE set of regions (each
 * `{healthy, latencyMs}`), pick where a NEW call's bot joins:
 *
 *   (a) a user-pinned override wins — but only when that region is present AND
 *       healthy; a pinned region that is unknown or degraded FAILS CLOSED and
 *       falls through to (b) with a log (a new call is never sent to a degraded
 *       region, even a pinned one);
 *   (b) otherwise the lowest-latency HEALTHY region, with deterministic
 *       round-robin within a latency tie.
 *
 * Degraded regions are skipped (fail closed); when any region was skipped the
 * chosen alternative is logged (§4.7). Already-IN_CALL calls are NOT migrated
 * (Recall has no cross-region migration) — that is a non-action here.
 *
 * With the default single-region set this returns `us-east`, so production
 * behavior is unchanged until a 2nd region is deployed.
 */
export function pickRegion(opts: PickRegionOptions = {}): string {
  const regions = opts.regions ?? DEFAULT_REGIONS;
  const logger = opts.logger ?? noopLogger;

  if (regions.length === 0) {
    throw new Error("pickRegion: no regions configured");
  }

  // (a) User-pinned override — honored only when healthy. A degraded/unknown pin
  //     fails closed (§4.7) and falls through to lowest-latency auto-selection.
  if (opts.pinned !== undefined) {
    const pin = regions.find((r) => r.region === opts.pinned);
    if (pin && pin.healthy) return pin.region;
    logger.info("orchestrate.region_pin_skipped", {
      pinned: opts.pinned,
      reason: pin ? "degraded" : "unknown",
    });
  }

  // (b) Lowest-latency HEALTHY region. Degraded regions are filtered out first —
  //     they can never be chosen for a new call (fail closed).
  const healthy = regions.filter((r) => r.healthy);
  if (healthy.length === 0) {
    throw new Error("pickRegion: no healthy region available (all degraded)");
  }
  const minLatency = Math.min(...healthy.map((r) => r.latencyMs));
  const tied = healthy
    .filter((r) => r.latencyMs === minLatency)
    .sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  const cursor = opts.tieBreaker ?? 0;
  const idx = ((cursor % tied.length) + tied.length) % tied.length;
  const chosen = tied[idx].region;

  // When any region was skipped as degraded, log the chosen alternative (§4.7).
  const skipped = regions.filter((r) => !r.healthy).map((r) => r.region);
  if (skipped.length > 0) {
    logger.info("orchestrate.region_selected", { chosen, skipped });
  }

  return chosen;
}

/**
 * Read the configurable region set from the environment (§4.7 config/env seam).
 * `SAMOGRAPH_REGIONS` is a JSON array of `{region,healthy,latencyMs}`; unset ⇒
 * {@link DEFAULT_REGIONS} (the single healthy `us-east`, prod behavior unchanged).
 * A set-but-malformed value throws a clear error rather than silently degrading.
 */
export function regionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): readonly RegionHealth[] {
  const raw = (env.SAMOGRAPH_REGIONS ?? "").trim();
  if (!raw) return DEFAULT_REGIONS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SAMOGRAPH_REGIONS is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "SAMOGRAPH_REGIONS must be a non-empty JSON array of {region,healthy,latencyMs}",
    );
  }
  return parsed.map((entry, i) => {
    const r = entry as Record<string, unknown>;
    if (
      typeof r?.region !== "string" ||
      typeof r?.healthy !== "boolean" ||
      typeof r?.latencyMs !== "number"
    ) {
      throw new Error(
        `SAMOGRAPH_REGIONS[${i}] must be {region:string, healthy:boolean, latencyMs:number}`,
      );
    }
    return { region: r.region, healthy: r.healthy, latencyMs: r.latencyMs };
  });
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
 * The public webhook base the Recall transcript webhook (which carries the per-call
 * ingest secret) registers against (§5.3). Returns the bare origin (path/trailing
 * slash stripped), or `undefined` when nothing is set (the region's tunnel base
 * applies). A set-but-malformed or non-https value throws a clear error — a real
 * bot must not silently register an unreachable/insecure webhook destination.
 *
 * PER-ENV (#193, same class as #190/#191): PREFER the per-env host samohost injects
 * on previews as `BASE_URL` over the prod-pointed `PUBLIC_WEBHOOK_BASE`. Without
 * this, a preview bot registers its transcript webhook against prod
 * (`samograph.samo.team`) and its live transcript lands in prod's stream — the
 * preview's own transcript comes back empty. Prod sets neither a preview `BASE_URL`
 * nor a divergent `PUBLIC_WEBHOOK_BASE`, so prod resolves to `PUBLIC_WEBHOOK_BASE`
 * exactly as before. The https validation covers whichever source wins.
 *
 * SECURITY: resolved from the TRUSTED process env at startup, NEVER a request
 * `Host` / `X-Forwarded-Host` (spoofable behind a proxy) — a webhook carrying the
 * ingest secret must never target an attacker-controlled host (cf. resolveSamoEnv).
 */
export function publicWebhookBase(env: Record<string, string | undefined> = process.env): string | undefined {
  // Prefer BASE_URL (the preview's own host) over PUBLIC_WEBHOOK_BASE (prod).
  const perEnv = perEnvBaseUrl(env);
  const source = perEnv ? "BASE_URL" : "PUBLIC_WEBHOOK_BASE";
  const raw = (perEnv ?? env.PUBLIC_WEBHOOK_BASE ?? "").trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${source} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${source} must be an https:// URL (got ${parsed.protocol}//…)`);
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
  const logger = deps.logger ?? noopLogger;
  // deps.region is a HARD override (wins outright); otherwise the §4.7 policy
  // chooses over the configured region set (default: single healthy us-east).
  const region =
    deps.region ??
    pickRegion({
      regions: deps.regions,
      pinned: deps.pinnedRegion,
      tieBreaker: deps.regionTieBreaker,
      logger,
    });
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
    // §5.12: carry the tenant's dictionary keyterms + language into the bot's
    // Deepgram config (the fake + real clients both build the payload from these).
    keyterms: job.keyterms,
    language: job.language,
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
    // §5.11 bot_join_total{could_not_join}: the createBot FAILURE path is the
    // orchestrator's one terminal outcome, emitted exactly once per failed job.
    // (The poller owns in_call / could_not_record / its own could_not_join.)
    deps.metrics?.incBotJoin("could_not_join");
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
