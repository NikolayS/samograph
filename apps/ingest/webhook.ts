/**
 * The ingest webhook authenticity front door (SPEC §5.3, §6.2 #7).
 *
 * `POST /webhook?bot=…&t=…` is the most security-sensitive call-path surface:
 * the Recall API key is shared across tenants (§4.4), so an external attacker
 * spoofing `?bot=<victim>` is the threat. This handler validates in the exact
 * §5.3 order, FAILS CLOSED (bodyless 4xx, one WARN, a `webhook_rejected_total`
 * increment, never reaching `dispatch`), and is idempotent under Recall's
 * at-least-once delivery via `(bot_id, recall_event_id)` (0003 / §6.2 #7).
 *
 * Validation order (each step's failure is final — no later step runs):
 *   1. Recall HMAC signature vs the per-region webhook secret  → 401 bad_signature
 *   2. `?bot=` resolves to a known `calls.recall_bot_id`        → 401 unknown_bot
 *   3. `?t=` matches `calls.ingest_secret_hash`, constant time → 401 ingest_secret_mismatch
 *      (an authenticated-but-malformed body is dropped here too → 401 malformed)
 *   4. Tenancy gate: the body's claimed `bot_id` must equal the authenticated
 *      `?bot=`; `setTenant` scopes the idempotency write to that tenant (§5.10)
 *                                                              → 403 cross_tenant
 *
 * Steps 1–3 are the §5.3 server↔Recall authenticity checks → `SAMO-WEBHOOK-401`
 * (§5.16). Step 4 is the tenancy gate → `SAMO-AUTHZ-001` (403), matching §6.2 #7
 * ("cross-tenant → 403 (tenancy gate)"). Only after all four pass does the
 * handler record the event and call the typed `dispatch(event)` seam — this
 * issue does NOT write transcript rows or transition call status (#78 / #79).
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import {
  RECALL_SIGNATURE_HEADER,
  verifyRecallSignature,
} from "../../packages/shared/recall/signature.ts";
import { setTenant } from "../../packages/shared/db/client.ts";
import { tokensEqual } from "../../src/server.ts";

/** Why a webhook was rejected — the `webhook_rejected_total{reason}` label (§5.11). */
export type WebhookRejectReason =
  | "bad_signature"
  | "unknown_bot"
  | "ingest_secret_mismatch"
  | "cross_tenant"
  | "malformed";

/** Counter port for `webhook_rejected_total{reason}` (§5.11). */
export interface WebhookMetrics {
  incRejected(reason: WebhookRejectReason): void;
}

/** Structured WARN logger — one line per rejection (§5.16). */
export interface WebhookLogger {
  warn(code: string, fields: Record<string, unknown>): void;
}

/** The privileged, pre-tenant resolution of `?bot=` → the owning call (§5.3 step 2). */
export interface CallIdentity {
  callId: string;
  tenantId: string;
  /** SHA-256 hex of the call's IngestSecret — the only form persisted (§4.2). */
  ingestSecretHash: string | null;
  /** The canonical Recall bot id on the call row (equals the validated `?bot=`). */
  recallBotId: string;
}

/** Provides the single per-region webhook secret for THIS regional process (§4.3). */
export interface WebhookSecretProvider {
  webhookSecret(): Promise<string>;
}

/** A validated, authentic, tenant-scoped event handed to the dispatch seam. */
export interface ValidatedEvent {
  kind: "transcript.data" | "bot.status_change";
  /** The authenticated `?bot=` (= `calls.recall_bot_id`). */
  botId: string;
  callId: string;
  tenantId: string;
  /** Idempotency key carried in the body — at-most-once per `(botId, …)` (§6.2 #7). */
  recallEventId: string;
  /** The inner Recall payload, passed through untouched for #78 / #79 to consume. */
  payload: { event: string; data: unknown };
}

/**
 * The typed seam the pipeline (#78) and lifecycle (#79) issues subscribe to.
 *
 * `tx` is the open dedup transaction (tenant context already set): a subscriber
 * does its persistence on it so its writes commit ATOMICALLY with the dedup row
 * — a throw rolls both back and Recall legitimately re-delivers, while a commit
 * is exactly-once. Threading `tx` is what makes "dispatch runs inside the tx"
 * actually deliverable for DB-writing subscribers like #78.
 */
export type Dispatch = (tx: SQL, event: ValidatedEvent) => Promise<void> | void;

export interface WebhookHandlerDeps {
  /** Single per-region webhook secret (mirrors bot-orchestrator's envSecretProvider). */
  secretProvider: WebhookSecretProvider;
  /** Privileged (pre-tenant) `?bot=` → call resolver; `null` when the bot is unknown. */
  lookupCallByBotId: (recallBotId: string) => Promise<CallIdentity | null>;
  /**
   * Privileged (pre-tenant) `?t=` → call resolver, keyed on `ingest_secret_hash`;
   * used when `?bot=` is ABSENT (the real-Recall path, §5.3 / amendment S2-10):
   * Recall registers the realtime webhook at createBot time with only
   * `?t=<ingest_secret>` because the assigned bot id is not yet known. `null` when
   * no call matches the hash (or the bot has not been acked yet — see
   * {@link pgLookupCallByIngestSecret}).
   */
  lookupCallByIngestSecret: (ingestSecretHash: string) => Promise<CallIdentity | null>;
  /** Connection used ONLY for the tenant-scoped idempotency write (never on reject paths). */
  sql: SQL;
  /** The downstream seam — invoked at most once per `(botId, recallEventId)`. */
  dispatch: Dispatch;
  metrics: WebhookMetrics;
  logger?: WebhookLogger;
}

/** Max raw body the front door will read (mirrors the CLI's webhook cap). */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

const KIND_TRANSCRIPT = "transcript.data";
const KIND_STATUS = "bot.status_change";

/** SHA-256 hex of a value — used to hash the presented `?t=` before the compare. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ParsedEnvelope {
  recallEventId: string;
  kind: "transcript.data" | "bot.status_change";
  /** `data.bot_id` for a status change (the body's self-claimed identity), else null. */
  bodyBotId: string | null;
  payload: { event: string; data: unknown };
}

/** Parse + shape-check the signed body; returns null on anything malformed. */
function parseEnvelope(rawBody: string): ParsedEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const recallEventId = obj.recall_event_id;
  const event = obj.event;
  if (typeof recallEventId !== "string" || recallEventId.length === 0) return null;
  if (event !== KIND_TRANSCRIPT && event !== KIND_STATUS) return null;

  let bodyBotId: string | null = null;
  if (event === KIND_STATUS) {
    const data = obj.data as { bot_id?: unknown } | undefined;
    bodyBotId = typeof data?.bot_id === "string" ? data.bot_id : null;
  }
  return {
    recallEventId,
    kind: event,
    bodyBotId,
    payload: { event, data: obj.data },
  };
}

/**
 * Build the §5.3 front-door handler. Returns an async `(Request) => Response`
 * with no body on any failure (the bytes Recall sees are the status code alone).
 */
export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const reject = (
    reason: WebhookRejectReason,
    status: 401 | 403,
    fields: Record<string, unknown> = {},
  ): Response => {
    deps.metrics.incRejected(reason);
    const code = status === 403 ? "SAMO-AUTHZ-001" : "SAMO-WEBHOOK-401";
    deps.logger?.warn(code, { reason, ...fields });
    return new Response(null, { status });
  };

  return async function handleWebhook(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }

    const rawBody = await request.text();
    if (rawBody.length > WEBHOOK_MAX_BYTES) return reject("malformed", 401);

    // ── 1. Recall HMAC signature vs the per-region webhook secret. ───────────
    // Rejects external spoofs that never went through Recall — checked FIRST, so
    // an unsigned attacker never reaches the privileged bot lookup or the DB.
    const secret = await deps.secretProvider.webhookSecret();
    const presented = request.headers.get(RECALL_SIGNATURE_HEADER);
    if (!verifyRecallSignature(rawBody, presented, secret)) {
      return reject("bad_signature", 401);
    }

    // ── 2. Resolve the owning call. Canonical path: `?bot=` → recall_bot_id +
    // a constant-time `?t=` check (step 3). Real-Recall path: when `?bot=` is
    // ABSENT (Recall registered `…/webhook?t=<ingest_secret>` at createBot time,
    // before its assigned bot id was known — §5.3 / amendment S2-10), resolve BY
    // the ingest secret's hash. That hashed, indexed lookup IS the `?t=` match, so
    // step 3 is not re-run for it. Neither key present → 401.
    const botParam = url.searchParams.get("bot");
    const tParam = url.searchParams.get("t");
    let identity: CallIdentity | null;
    if (botParam) {
      identity = await deps.lookupCallByBotId(botParam);
      if (!identity) return reject("unknown_bot", 401, { botId: botParam });

      // ── 3. `?t=` matches `calls.ingest_secret_hash`, in constant time. ─────
      // We hold only the hash; hash the presented plaintext and constant-time
      // compare via the CLI's `tokensEqual` (fails closed on empty/missing).
      const presentedHash = botParamSecretHash(tParam);
      if (!tokensEqual(presentedHash, identity.ingestSecretHash)) {
        return reject("ingest_secret_mismatch", 401, { botId: botParam });
      }
    } else if (tParam) {
      // Finding the row BY sha256(t) IS the §5.3 secret match (the 256-bit secret
      // makes its hash a unique probe). The resolver returns null when no call
      // matches OR the bot has not been acked yet (recall_bot_id NULL) — fail
      // closed so Recall re-delivers (§6.2 #7).
      identity = await deps.lookupCallByIngestSecret(sha256Hex(tParam));
      if (!identity) return reject("unknown_bot", 401);
    } else {
      return reject("unknown_bot", 401);
    }

    // An authentic-but-malformed body is dropped here (never reaches dispatch).
    const envelope = parseEnvelope(rawBody);
    if (!envelope) return reject("malformed", 401, { botId: botParam });

    // ── 4. Tenancy gate. The body must not claim a DIFFERENT bot than the one
    // we authenticated `?bot=` against (that is the cross-tenant spoof). This
    // runs BEFORE any write, so a denied request never touches the DB (§5.6).
    if (envelope.bodyBotId !== null && envelope.bodyBotId !== identity.recallBotId) {
      return reject("cross_tenant", 403, {
        botId: botParam,
        claimedBotId: envelope.bodyBotId,
      });
    }

    const validated: ValidatedEvent = {
      kind: envelope.kind,
      botId: identity.recallBotId,
      callId: identity.callId,
      tenantId: identity.tenantId,
      recallEventId: envelope.recallEventId,
      payload: envelope.payload,
    };

    // Idempotency + dispatch atomically under the call's tenant context. INSERT
    // ... ON CONFLICT DO NOTHING: a NEW row → dispatch; a re-delivery → 0 rows →
    // skip dispatch (at-most-once). Dispatch runs INSIDE the tx so a throw rolls
    // back the dedup row and a Recall re-delivery legitimately retries it.
    await deps.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, identity.tenantId);
      const inserted = (await tx`
        INSERT INTO webhook_events (bot_id, recall_event_id)
        VALUES (${identity.recallBotId}, ${envelope.recallEventId})
        ON CONFLICT (bot_id, recall_event_id) DO NOTHING
        RETURNING 1 AS ok`) as unknown as unknown[];
      if (inserted.length > 0) {
        await deps.dispatch(tx, validated);
      }
    });

    return Response.json({ ok: true });
  };
}

/** Hash the presented `?t=` plaintext for the constant-time compare (or "" → fail closed). */
function botParamSecretHash(t: string | null): string {
  return t ? sha256Hex(t) : "";
}

/**
 * Reads the single per-region webhook secret from the environment (the v1
 * secret-manager placeholder, §4.4 / §4.10) — mirrors bot-orchestrator's
 * `envSecretProvider`. The secret never leaves this boundary.
 */
export function envWebhookSecretProvider(): WebhookSecretProvider {
  return {
    async webhookSecret() {
      const secret = process.env.RECALL_WEBHOOK_SECRET ?? "";
      if (!secret) throw new Error("RECALL_WEBHOOK_SECRET is not set");
      return secret;
    },
  };
}

/** In-memory {@link WebhookSecretProvider} for tests / local dev. */
export function inMemoryWebhookSecretProvider(secret: string): WebhookSecretProvider {
  return {
    async webhookSecret() {
      return secret;
    },
  };
}

/** In-memory {@link WebhookMetrics} for tests — exposes the per-reason counts. */
export function inMemoryWebhookMetrics(): WebhookMetrics & {
  rejected: Partial<Record<WebhookRejectReason, number>>;
} {
  const rejected: Partial<Record<WebhookRejectReason, number>> = {};
  return {
    rejected,
    incRejected(reason) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
    },
  };
}

/**
 * Privileged (pre-tenant) `?bot=` → {@link CallIdentity} resolver over Postgres,
 * mirroring the tenancy gate's `lookupCallTenant`. Runs BEFORE any tenant
 * context exists, on a connection that can read `calls` across tenants.
 */
export function pgLookupCallByBotId(
  sql: SQL,
): (recallBotId: string) => Promise<CallIdentity | null> {
  return async (recallBotId) => {
    const rows = (await sql`
      SELECT id, tenant_id, ingest_secret_hash, recall_bot_id
      FROM calls
      WHERE recall_bot_id = ${recallBotId}
      LIMIT 1`) as unknown as Array<{
      id: string;
      tenant_id: string;
      ingest_secret_hash: string | null;
      recall_bot_id: string;
    }>;
    if (rows.length === 0) return null;
    return {
      callId: rows[0].id,
      tenantId: rows[0].tenant_id,
      ingestSecretHash: rows[0].ingest_secret_hash,
      recallBotId: rows[0].recall_bot_id,
    };
  };
}

/**
 * Privileged (pre-tenant) `?t=` → {@link CallIdentity} resolver over Postgres,
 * keyed on `ingest_secret_hash` (indexed by migration 0005). Used for the
 * real-Recall path where Recall registered `…/webhook?t=<ingest_secret>` at
 * createBot time (no `?bot=` yet, §5.3 / amendment S2-10). Finding the row BY the
 * presented secret's hash IS the §5.3 authenticity match — there is no separate
 * constant-time compare (the 256-bit secret makes the hash a unique probe).
 *
 * Returns `null` when no call matches OR when the call's `recall_bot_id` is still
 * NULL (the bot has not been acked yet): the dedup ledger + `webhook_events` RLS
 * key on `recall_bot_id`, so we fail closed and let Recall re-deliver (§6.2 #7).
 */
export function pgLookupCallByIngestSecret(
  sql: SQL,
): (ingestSecretHash: string) => Promise<CallIdentity | null> {
  return async (ingestSecretHash) => {
    const rows = (await sql`
      SELECT id, tenant_id, ingest_secret_hash, recall_bot_id
      FROM calls
      WHERE ingest_secret_hash = ${ingestSecretHash}
      LIMIT 1`) as unknown as Array<{
      id: string;
      tenant_id: string;
      ingest_secret_hash: string | null;
      recall_bot_id: string | null;
    }>;
    const row = rows[0];
    if (!row || !row.recall_bot_id) return null;
    return {
      callId: row.id,
      tenantId: row.tenant_id,
      ingestSecretHash: row.ingest_secret_hash,
      recallBotId: row.recall_bot_id,
    };
  };
}
