/**
 * Ingest bot-lifecycle → call status, pickup-latency SLO, and in-call recording
 * disclosure (SPEC §5.2, §5.9, §5.11, §5.16; issue #79).
 *
 * Call status is driven by Recall `bot.status_change` events, NOT transcript
 * traffic — a SILENT call (zero `transcript.data`) must still reach `IN_CALL`
 * (§5.2). This handler subscribes to the merged #93 `dispatch(tx, event)` seam
 * as a PEER of the #78 transcript pipeline (the transcript dispatch acts only on
 * `transcript.data`; this one acts only on `bot.status_change`), and:
 *
 *   validated `bot.status_change` event
 *     → map `status.code` → a `calls.status` transition (§5.2 / §5.16)
 *     → apply it as a CONDITIONAL UPDATE so a terminal status is sticky:
 *        out-of-order / duplicate events can never regress it
 *     → audit the transition (`audit_log`, actor `system`, `payload_sha256`)
 *     → publish a `{type:"status"}` control frame on the per-`call_id`
 *        `TranscriptPublisher` channel (§95) so the ws-hub / per-call page
 *        reflect status live — this is the "status-visible" SLO endpoint
 *     → on the FIRST `in_call_recording` pickup only: post the §5.9 disclosure
 *        chat exactly once via the bot-worker (`POST /v1/call/:id/chat`, §94)
 *     → on `in_call_not_recording`: post NOTHING and `leave` cleanly (§5.9)
 *     → record `pickup_latency_ms{p50,p95,p99}` (event-received → status-visible)
 *
 * It runs INSIDE the §93 webhook dedup transaction (wired as `dispatch`): the
 * dedup ledger makes a Recall re-delivery a no-op, and a thrown side effect
 * (failed disclosure post / leave) rolls back the transition AND the dedup row,
 * so Recall legitimately retries (at-least-once). The PENDING/JOINING→IN_CALL
 * guard means a re-emitted DISTINCT `in_call_recording` never double-posts.
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import type {
  TranscriptControlFrame,
  TranscriptPublisher,
} from "../../packages/shared/transcript/publisher.ts";
import type { Dispatch, ValidatedEvent } from "./webhook.ts";

/** The byte-exact §5.9 recording disclosure (em-dash U+2014; ASCII apostrophes). */
export const DISCLOSURE_TEXT =
  "samograph is recording this call's audio for the host's live transcript — samograph.dev";

/** §5.16 terminal-status error codes owned by this handler. */
export const SAMO_CALL_JOIN = "SAMO-CALL-JOIN";
export const SAMO_CALL_NOREC = "SAMO-CALL-NOREC";
export const SAMO_CALL_REMOVED = "SAMO-CALL-REMOVED";

/** The `calls.status` enum values (§5.2). */
type CallStatus =
  | "PENDING"
  | "JOINING"
  | "IN_CALL"
  | "ENDED"
  | "COULD_NOT_JOIN"
  | "COULD_NOT_RECORD"
  | "BOT_REMOVED";

/** Statuses from which a NEW transition is allowed — i.e. not yet terminal (§5.2). */
const NON_TERMINAL: readonly CallStatus[] = ["PENDING", "JOINING", "IN_CALL"];

/** What a Recall lifecycle code means for the call (§5.2 / §5.9 / §5.16). */
export interface LifecycleTransition {
  /** Target `calls.status`. */
  status: CallStatus;
  /** Terminal statuses are sticky and reset `ingest_degraded` (0002 trigger). */
  terminal: boolean;
  /** Post the §5.9 disclosure once on the first pickup (only `in_call_recording`). */
  postDisclosure: boolean;
  /** Make the bot leave cleanly via the bot-worker (only `in_call_not_recording`). */
  leave: boolean;
  /** Persist Recall's `status.sub_code` reason on the call (only `fatal`). */
  persistReason: boolean;
  /** The §5.16 error code surfaced for this terminal status, if any. */
  errorCode: string | null;
}

/**
 * Map a Recall `bot.status_change` code → its {@link LifecycleTransition}, or
 * `null` for an unrecognised code (a no-op that never touches the database).
 * Pure — the single source of truth the handler and its tests share.
 */
export function mapLifecycleCode(code: string): LifecycleTransition | null {
  switch (code) {
    case "in_call_recording":
      return {
        status: "IN_CALL",
        terminal: false,
        postDisclosure: true,
        leave: false,
        persistReason: false,
        errorCode: null,
      };
    case "in_call_not_recording":
      return {
        status: "COULD_NOT_RECORD",
        terminal: true,
        postDisclosure: false,
        leave: true,
        persistReason: false,
        errorCode: SAMO_CALL_NOREC,
      };
    case "call_ended":
      return {
        status: "ENDED",
        terminal: true,
        postDisclosure: false,
        leave: false,
        persistReason: false,
        errorCode: null,
      };
    case "bot_removed":
      return {
        status: "BOT_REMOVED",
        terminal: true,
        postDisclosure: false,
        leave: false,
        persistReason: false,
        errorCode: SAMO_CALL_REMOVED,
      };
    case "fatal":
      return {
        status: "COULD_NOT_JOIN",
        terminal: true,
        postDisclosure: false,
        leave: false,
        persistReason: true,
        errorCode: SAMO_CALL_JOIN,
      };
    default:
      return null;
  }
}

/** `pickup_latency_ms` summary (§5.11), nearest-rank from a recorded sample. */
export interface PickupLatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Nearest-rank p50/p95/p99 over a latency sample (§5.11). Rank = `ceil(p/100·n)`
 * (1-indexed), clamped to the last element; an empty sample is all zeros. Pure,
 * non-mutating (sorts a copy) — the metric the §6.2 #8 SLO asserts.
 */
export function pickupLatencyPercentiles(samplesMs: number[]): PickupLatencyPercentiles {
  if (samplesMs.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return { p50: at(50), p95: at(95), p99: at(99) };
}

/**
 * The bot-worker act port the disclosure / clean-leave use (§5.8 / §94). In prod
 * a thin adapter resolves the worker from the `workers` table and POSTs to
 * `/v1/call/:id/{chat,leave}` with the per-instance Bearer; in tests it is a spy
 * (the §6.2 #8 / §5.9 acceptance "spy on bot-worker chat"). Reimplementing the
 * worker is out of scope (§94).
 */
export interface BotWorkerPort {
  /** `POST /v1/call/:id/chat {message}` — post the §5.9 disclosure. */
  chat(callId: string, message: string): Promise<void> | void;
  /** `POST /v1/call/:id/leave` — leave cleanly on `in_call_not_recording`. */
  leave(callId: string): Promise<void> | void;
}

/** In-memory {@link BotWorkerPort} spy for tests — records every chat / leave. */
export function inMemoryBotWorker(): BotWorkerPort & {
  chats: Array<{ callId: string; message: string }>;
  leaves: string[];
} {
  const chats: Array<{ callId: string; message: string }> = [];
  const leaves: string[] = [];
  return {
    chats,
    leaves,
    chat(callId, message) {
      chats.push({ callId, message });
    },
    leave(callId) {
      leaves.push(callId);
    },
  };
}

/** Counter port for `pickup_latency_ms` (§5.11): event-received → status-visible. */
export interface BotLifecycleMetrics {
  observePickupLatencyMs(ms: number): void;
}

/** In-memory {@link BotLifecycleMetrics} for tests — exposes the raw sample. */
export function inMemoryBotLifecycleMetrics(): BotLifecycleMetrics & {
  pickupSamples: number[];
} {
  const pickupSamples: number[] = [];
  return {
    pickupSamples,
    observePickupLatencyMs(ms) {
      pickupSamples.push(ms);
    },
  };
}

export interface BotLifecycleDeps {
  /** Per-call fan-out seam (in-memory fake in tests; LISTEN/NOTIFY in prod). */
  publisher: TranscriptPublisher;
  /** Bot-worker act port for the disclosure post / clean leave (§94). */
  worker: BotWorkerPort;
  /** `pickup_latency_ms` counter (§5.11). */
  metrics: BotLifecycleMetrics;
  /** Monotonic millisecond clock; injectable for the deterministic SLO sample. */
  clock?: () => number;
}

export interface BotLifecycle {
  /**
   * Apply ONE validated `bot.status_change` event. Must run inside the §93 dedup
   * tx (the call's tenant context already set). A non-status event, an
   * unrecognised code, or an event that would regress a terminal status is a
   * no-op (no transition, no publish, no side effect).
   */
  handleLifecycleEvent(tx: SQL, validated: ValidatedEvent): Promise<void>;
  /** The {@link Dispatch} adapter the webhook front door (#93) subscribes to. */
  dispatch: Dispatch;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** Pull `status.code` / `status.sub_code` out of a `bot.status_change` payload. */
function readStatus(payload: ValidatedEvent["payload"]): { code: string; subCode: string | null } | null {
  const data = (payload as { data?: { status?: { code?: unknown; sub_code?: unknown } } }).data;
  const status = data?.status;
  if (!status || typeof status.code !== "string") return null;
  return {
    code: status.code,
    subCode: typeof status.sub_code === "string" ? status.sub_code : null,
  };
}

/**
 * Build the bot-lifecycle handler. The returned `handleLifecycleEvent` is also
 * exposed as a {@link Dispatch} (`dispatch`) that acts ONLY on `bot.status_change`
 * — `transcript.data` events flow to the #78 pipeline, never here.
 */
export function createBotLifecycle(deps: BotLifecycleDeps): BotLifecycle {
  const clock = deps.clock ?? Date.now;

  async function handleLifecycleEvent(tx: SQL, validated: ValidatedEvent): Promise<void> {
    if (validated.kind !== "bot.status_change") return;
    const parsed = readStatus(validated.payload);
    if (!parsed) return;
    const transition = mapLifecycleCode(parsed.code);
    if (!transition) return;

    const { callId, tenantId } = validated;
    const payloadSha = sha256Hex(JSON.stringify(validated.payload));

    // "Event received": the moment ingest hands this pickup to the handler. Read
    // only for the pickup transition so the SLO sample is exactly one per pickup.
    const receivedAt = transition.postDisclosure ? clock() : 0;

    // Apply the transition as a CONDITIONAL UPDATE so a terminal status is sticky.
    //  - in_call_recording: only PENDING/JOINING→IN_CALL (idempotent + a guard so
    //    a re-emitted distinct event never re-posts the disclosure).
    //  - terminal codes: only from a NON-terminal status (never regress a terminal
    //    one) — also stamps ended_at and, for `fatal`, the Recall reason.
    const changed = transition.terminal
      ? await applyTerminal(tx, callId, transition, parsed.subCode)
      : await applyInCall(tx, callId);
    if (!changed) return;

    // Audit the transition (actor `system`, payload sha256), then publish the
    // status control frame — the per-call channel reflects status live (§5.2).
    await audit(tx, tenantId, callId, "system", `call.status.${transition.status}`, payloadSha);
    const frame: TranscriptControlFrame = { type: "status", call_id: callId, status: transition.status };
    if (transition.persistReason && parsed.subCode) frame.reason = parsed.subCode;
    await deps.publisher.publish(frame, tx);

    // "Status visible" — record pickup latency for the in_call_recording pickup.
    if (transition.postDisclosure) {
      deps.metrics.observePickupLatencyMs(clock() - receivedAt);
    }

    // §5.9 side effects. Disclosure posts ONCE on the first pickup; a not-recording
    // call posts NOTHING and leaves cleanly. Both are audited (actor `bot`).
    if (transition.postDisclosure) {
      await deps.worker.chat(callId, DISCLOSURE_TEXT);
      await audit(tx, tenantId, callId, "bot", "call.disclosure", sha256Hex(DISCLOSURE_TEXT));
    }
    if (transition.leave) {
      await deps.worker.leave(callId);
      await audit(tx, tenantId, callId, "bot", "call.leave", null);
    }
  }

  const dispatch: Dispatch = (tx, validated) =>
    validated.kind === "bot.status_change" ? handleLifecycleEvent(tx, validated) : undefined;

  return { handleLifecycleEvent, dispatch };
}

/** PENDING/JOINING → IN_CALL. Returns true iff this delivery made the pickup. */
async function applyInCall(tx: SQL, callId: string): Promise<boolean> {
  const rows = (await tx`
    UPDATE calls SET status = 'IN_CALL'
    WHERE id = ${callId} AND status IN ('PENDING', 'JOINING')
    RETURNING id`) as unknown as unknown[];
  return rows.length > 0;
}

/** A non-terminal status → the terminal `status`. Returns true iff it applied. */
async function applyTerminal(
  tx: SQL,
  callId: string,
  transition: LifecycleTransition,
  subCode: string | null,
): Promise<boolean> {
  const reason = transition.persistReason ? subCode : null;
  const rows = (await tx`
    UPDATE calls
       SET status = ${transition.status}::call_status,
           ended_at = COALESCE(ended_at, now()),
           status_reason = COALESCE(${reason}::text, status_reason)
     WHERE id = ${callId}
       AND status IN ${tx(NON_TERMINAL as unknown as string[])}
    RETURNING id`) as unknown as unknown[];
  return rows.length > 0;
}

/** Append one `audit_log` row under the call's tenant context (RLS-checked). */
async function audit(
  tx: SQL,
  tenantId: string,
  callId: string,
  actor: string,
  action: string,
  payloadSha256: string | null,
): Promise<void> {
  await tx`
    INSERT INTO audit_log (tenant_id, call_id, actor, action, payload_sha256)
    VALUES (${tenantId}, ${callId}, ${actor}, ${action}, ${payloadSha256})`;
}

/**
 * Fan one event to every subscriber on the shared #93 `dispatch(tx, event)` seam,
 * in order (e.g. the #78 transcript pipeline + this lifecycle handler). Each acts
 * only on its own event kind, so exactly one does work per event; a throw in any
 * subscriber propagates and rolls back the dedup tx (Recall retries).
 */
export function composeDispatch(...dispatchers: Dispatch[]): Dispatch {
  return async (tx, event) => {
    for (const d of dispatchers) await d(tx, event);
  };
}
