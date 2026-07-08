/**
 * Recall bot-STATUS POLLER (SPEC §5.2; issue #118).
 *
 * Real Recall does NOT deliver `bot.status_change` over the realtime transcript
 * endpoint — registering it there is rejected with HTTP 400 ("not a valid
 * choice", see `recallClient.ts` `buildRealCreateBotPayload`) — so on live calls
 * the ingest lifecycle handler (#79) never sees a status event and `calls.status`
 * sticks at JOINING forever while the transcript flows.
 *
 * This poller closes that gap from the ORCHESTRATOR side of the §4.4 Recall key
 * boundary: on an interval (10 s), for every NON-terminal call
 * (PENDING/JOINING/IN_CALL) that has a `recall_bot_id`, it reads the bot's
 * `status_changes` history from `GET /api/v1/bot/<id>/` (behind the
 * {@link BotStatusSource} seam — the in-repo fake in tests, the real client in
 * prod), maps the LATEST code onto our `calls.status`, and applies it as a
 * FORWARD-ONLY conditional UPDATE:
 *
 *   - a terminal status is STICKY — the WHERE clause only matches non-terminal
 *     rows, so a stale poll can never regress ENDED/COULD_NOT_JOIN/…;
 *   - within non-terminal, only rank-increasing moves apply
 *     (PENDING < JOINING < IN_CALL) — IN_CALL never falls back to JOINING;
 *   - a terminal transition stamps `ended_at` and (for fatal) persists the
 *     Recall `sub_code` reason, mirroring the #79 lifecycle handler's UPDATE.
 *
 * A transition that APPLIES additionally (all riding the SAME transaction as
 * the conditional UPDATE, mirroring the #79 lifecycle handler):
 *
 *   - is audited (`audit_log`, actor `system`, sha of the polled entry);
 *   - on `in_call_recording`: posts the §5.9 recording disclosure chat via the
 *     real-Recall {@link BotActions} and audits it (actor `bot`) — a
 *     NON-idempotent external POST, so it runs OUTSIDE the status-flip tx,
 *     guarded by the durable `calls.disclosure_posted_at` marker (send-then-
 *     stamp): sent at most once, retried only while unsent, never rolling back
 *     the already-committed IN_CALL status (COULD_NOT_RECORD can never regress
 *     a live IN_CALL row — §5.9);
 *   - on an `in_call_not_recording` that outlived {@link NOT_RECORDING_GRACE_MS}
 *     (i.e. recording never started): posts NOTHING (a "recording" disclosure
 *     would be factually wrong, §5.9), transitions to COULD_NOT_RECORD, and
 *     makes the bot LEAVE cleanly; a fresh `in_call_not_recording` is the
 *     normal transient pre-recording hop and stays JOINING;
 *   - publishes a `{type:"status"}` control frame on the SAME per-call
 *     `TranscriptPublisher` channel the transcript path uses (§5.5 / #98 —
 *     `pg_notify('transcript:<call_id>', '{"k":"ctl","frame":…}')` in prod), so
 *     the ws-hub fan-in forwards it to the call's open WS subscribers and the
 *     per-call page updates live without a reload (#106). Inside the tx the
 *     NOTIFY is commit-gated: a rolled-back transition publishes nothing.
 *
 * This is an INFRA sweep (like the bot-orchestrator's own `UPDATE calls` and the
 * #81 tunnel watchdog): it crosses tenants, so it runs on a privileged
 * connection that bypasses RLS — NEVER under a tenant role. The conditional
 * UPDATE is idempotent, so concurrent sweeps (or a poll racing a future webhook
 * delivery) are safe; an in-flight guard keeps one process's ticks from
 * overlapping. Scheduler/clock/interval are injectable (the #81 watchdog
 * pattern) so tests drive `tick()` directly — no timers, no network, no key.
 */
import type { SQL } from "bun";
import { RECALL_BASE } from "../../src/config.ts";
import type { FetchFn } from "../../src/recall.ts";
import { sha256Hex } from "../../packages/shared/crypto.ts";
import type {
  TranscriptControlFrame,
  TranscriptPublisher,
} from "../../packages/shared/transcript/publisher.ts";
import { DISCLOSURE_TEXT } from "../ingest/botLifecycle.ts";
import type { BotActions } from "./recallBotActions.ts";
import type { BotJoinMetrics } from "./botJoinMetrics.ts";

/** The `calls.status` enum values (§5.2). */
export type PolledCallStatus =
  | "PENDING"
  | "JOINING"
  | "IN_CALL"
  | "ENDED"
  | "COULD_NOT_JOIN"
  | "COULD_NOT_RECORD"
  | "BOT_REMOVED";

/** One entry of the real bot payload's `status_changes` history. */
export interface StatusChange {
  code: string;
  sub_code?: string | null;
  created_at?: string;
}

/**
 * The polled status channel, stubbed behind a seam so tests never need
 * RECALL_API_KEY or the network: the in-repo fake
 * (`packages/test-fakes/recall` `createFakeBotStatusSource`) in tests; the real
 * `GET /api/v1/bot/<id>/` client ({@link liveBotStatusSource}) in production.
 */
export interface BotStatusSource {
  /** The bot's full `status_changes` history, oldest first. */
  getStatus(botId: string): Promise<StatusChange[]>;
}

/** Default sweep interval (~10 s — well under the §5.2 pickup expectations). */
export const STATUS_POLL_INTERVAL_MS = 10_000;

/**
 * Map one Recall `status_changes.code` → our `calls.status`, or `null` for an
 * unrecognised/neutral code (a no-op that never touches the database). Pure —
 * the single source of truth the poller and its table-driven tests share.
 *
 * NOTE this is the POLLED-history mapping (issue #118), not the #79 webhook
 * event mapping: here `in_call_not_recording` is (initially) a transient
 * pre-recording hop (→ JOINING) — {@link resolvePolledTransition} escalates it
 * to the §5.9 COULD_NOT_RECORD + clean-leave outcome once it outlives
 * {@link NOT_RECORDING_GRACE_MS} — and the explicit `recording_permission_denied`
 * code carries the immediate COULD_NOT_RECORD outcome.
 */
export function mapPolledCode(code: string): PolledCallStatus | null {
  switch (code) {
    case "in_call_recording":
      return "IN_CALL";
    case "call_ended":
    case "recording_done":
    case "done":
      return "ENDED";
    case "recording_permission_denied":
      return "COULD_NOT_RECORD";
    case "joining_call":
    case "in_waiting_room":
    case "in_call_not_recording":
      return "JOINING";
    case "fatal":
    case "error":
      return "COULD_NOT_JOIN";
    default:
      return null;
  }
}

/**
 * The newest `status_changes` entry: greatest `created_at` (ISO-8601 strings
 * compare lexicographically); ties and missing timestamps resolve to the LATER
 * array entry, matching Recall's append-chronological history. `null` if empty.
 */
export function latestChange(changes: StatusChange[]): StatusChange | null {
  let latest: StatusChange | null = null;
  for (const change of changes) {
    if (!latest || (change.created_at ?? "") >= (latest.created_at ?? "")) {
      latest = change;
    }
  }
  return latest;
}

/**
 * How long `in_call_not_recording` may persist as the LATEST polled status
 * before it means "recording never started" (§5.9 → COULD_NOT_RECORD + leave).
 * On a healthy call the hop lasts seconds before `in_call_recording` follows;
 * 30 s (three sweeps) cleanly separates the hop from a genuinely blocked
 * recording without ever killing a call that was about to record.
 */
export const NOT_RECORDING_GRACE_MS = 30_000;

/** One polled transition + its §5.9 side effects (the poller's #79 analog). */
export interface PolledTransition {
  /** Target `calls.status`. */
  status: PolledCallStatus;
  /** Post the §5.9 disclosure once on the first pickup (only `in_call_recording`). */
  postDisclosure: boolean;
  /** Make the bot leave cleanly (only an aged `in_call_not_recording`, §5.9). */
  leave: boolean;
}

/**
 * Resolve the latest polled entry into a transition + side effects. Pure — the
 * single source of truth `tick()` and the table-driven tests share:
 *
 *   - `in_call_recording` → IN_CALL, posting the §5.9 disclosure;
 *   - `in_call_not_recording` younger than {@link NOT_RECORDING_GRACE_MS} (or
 *     with a missing/malformed `created_at` — never destroy a call on bad
 *     data) → the transient JOINING hop, NO side effects;
 *   - `in_call_not_recording` at/past the grace → COULD_NOT_RECORD + clean
 *     leave, NO disclosure (§5.9 — claiming "recording" would be wrong);
 *   - every other code → {@link mapPolledCode} with no side effects.
 */
export function resolvePolledTransition(
  latest: StatusChange,
  nowMs: number,
): PolledTransition | null {
  if (latest.code === "in_call_not_recording") {
    const createdMs = latest.created_at ? Date.parse(latest.created_at) : Number.NaN;
    const aged = Number.isFinite(createdMs) && nowMs - createdMs >= NOT_RECORDING_GRACE_MS;
    return aged
      ? { status: "COULD_NOT_RECORD", postDisclosure: false, leave: true }
      : { status: "JOINING", postDisclosure: false, leave: false };
  }
  const status = mapPolledCode(latest.code);
  if (!status) return null;
  return { status, postDisclosure: latest.code === "in_call_recording", leave: false };
}

/** Injectable seams for {@link liveBotStatusSource} (recallClient.ts pattern). */
export interface LiveBotStatusSourceDeps {
  /** Fetch for the real call (a stub in tests, the global `fetch` in prod). */
  fetch?: FetchFn;
  /** Environment to read `RECALL_API_KEY` from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * The production {@link BotStatusSource}: `GET ${RECALL_BASE}/bot/<id>/` with
 * `Authorization: Token <RECALL_API_KEY>`. The key is read from the injected
 * env at request time and appears ONLY in the Authorization header — never in
 * logs, errors, or return values. Malformed `status_changes` entries are
 * dropped; a payload without the array is `[]`.
 */
export function liveBotStatusSource(deps: LiveBotStatusSourceDeps = {}): BotStatusSource {
  const fetchFn = deps.fetch ?? fetch;
  return {
    async getStatus(botId: string): Promise<StatusChange[]> {
      const env = deps.env ?? process.env;
      const key = (env.RECALL_API_KEY ?? "").trim();
      if (!key) throw new Error("RECALL_API_KEY is not set — cannot poll bot status");
      const r = await fetchFn(`${RECALL_BASE}/bot/${encodeURIComponent(botId)}/`, {
        method: "GET",
        headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      // Deliberately no response-body echo in the error (defense in depth: the
      // poller's warn log must never carry anything Recall might reflect).
      if (!r.ok) throw new Error(`get bot status failed: HTTP ${r.status}`);
      const bot = (await r.json()) as { status_changes?: unknown };
      const raw = bot?.status_changes;
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (c): c is StatusChange =>
          !!c && typeof (c as { code?: unknown }).code === "string",
      );
    },
  };
}

/** Forward-only rank: a transition applies only from a strictly lower rank. */
const RANK: Record<PolledCallStatus, number> = {
  PENDING: 0,
  JOINING: 1,
  IN_CALL: 2,
  ENDED: 3,
  COULD_NOT_JOIN: 3,
  COULD_NOT_RECORD: 3,
  BOT_REMOVED: 3,
};

/** Statuses the sweep considers (i.e. not yet terminal, §5.2). */
const NON_TERMINAL: readonly PolledCallStatus[] = ["PENDING", "JOINING", "IN_CALL"];

/**
 * The §5.11 `bot_join_total{result}` label for a polled transition target, or
 * `undefined` for a status that is not a join OUTCOME (issue #107). ENDED /
 * BOT_REMOVED / a JOINING hop are lifecycle moves, not join outcomes, so they
 * never touch the counter. Emitted only when the forward-only UPDATE APPLIED, so
 * each of the three outcomes fires at most once per call.
 */
const BOT_JOIN_RESULT_BY_STATUS: Partial<Record<PolledCallStatus, string>> = {
  IN_CALL: "in_call",
  COULD_NOT_JOIN: "could_not_join",
  COULD_NOT_RECORD: "could_not_record",
};

export interface StatusPollerDeps {
  /** PRIVILEGED infra connection (bypasses RLS — the sweep crosses tenants). */
  sql: SQL;
  /** The polled status channel (fake in tests; {@link liveBotStatusSource} live). */
  source: BotStatusSource;
  /**
   * Bot act channel for the §5.9 side effects (disclosure chat / clean leave):
   * a spy in tests; `liveRecallBotActions()` (the real Recall API) in prod.
   */
  actions: BotActions;
  /**
   * Per-call fan-out seam for the live `{type:"status"}` frame (#106): the
   * `PgListenNotifyPublisher` in prod (same NOTIFY channel/payload as the
   * transcript path), an in-memory fake in tests. Omitted ⇒ no live push
   * (status still lands in Postgres and shows on reload).
   */
  publisher?: TranscriptPublisher;
  /**
   * §5.11 `bot_join_total{result}` producer (issue #107). On a forward-only
   * terminal transition that APPLIES, the poller increments `in_call` /
   * `could_not_join` / `could_not_record` EXACTLY once; a duplicate poll matches
   * 0 rows so it never double-counts. Carries only the outcome label — never the
   * Recall key (§4.4). Omitted ⇒ no metric.
   */
  metrics?: BotJoinMetrics;
  /** Wall clock (ms) for the `in_call_not_recording` grace; injectable in tests. */
  clock?: () => number;
  /** Sweep interval (defaults to {@link STATUS_POLL_INTERVAL_MS}). */
  intervalMs?: number;
  /** Scheduler seam (defaults to an unref'd `setInterval`); tests drive `tick()`. */
  schedule?: (fn: () => void, ms: number) => { stop(): void };
  /** Per-bot lookup failures are logged (bot id only — NEVER key material). */
  logger?: { warn(msg: string): void };
}

export interface StatusPollerHandle {
  /** Run ONE sweep. The schedule calls it; tests drive it directly. */
  tick(): Promise<void>;
  stop(): void;
}

function defaultSchedule(fn: () => void, ms: number): { stop(): void } {
  const timer = setInterval(fn, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Apply one polled transition as a forward-only conditional UPDATE. The WHERE
 * clause is the whole safety story: it matches only non-terminal statuses of a
 * strictly LOWER rank than the target, so a terminal row is untouchable and
 * IN_CALL never regresses — concurrent sweeps and webhook deliveries commute.
 */
async function applyForward(
  sql: SQL,
  callId: string,
  target: PolledCallStatus,
  subCode: string | null,
): Promise<boolean> {
  let from = NON_TERMINAL.filter((s) => RANK[s] < RANK[target]);
  // COULD_NOT_RECORD means recording NEVER started (§5.9): it must never regress a
  // live IN_CALL call (recording DID start) to a terminal "couldn't record" and
  // eject the bot — only a pre-recording PENDING/JOINING row may escalate.
  // (samorev gate: destructive IN_CALL→COULD_NOT_RECORD regression.)
  if (target === "COULD_NOT_RECORD") from = from.filter((s) => s !== "IN_CALL");
  if (from.length === 0) return false; // nothing below the target is eligible

  if (RANK[target] >= 3) {
    // Terminal: stamp ended_at; a FAILURE's sub_code becomes the §5.16 reason
    // (`fatal` → COULD_NOT_JOIN, `recording_permission_denied` → COULD_NOT_RECORD).
    const reason =
      target === "COULD_NOT_JOIN" || target === "COULD_NOT_RECORD" ? subCode : null;
    const rows = (await sql`
      UPDATE calls
         SET status = ${target}::call_status,
             ended_at = COALESCE(ended_at, now()),
             status_reason = COALESCE(${reason}::text, status_reason)
       WHERE id = ${callId}
         AND status IN ${sql(from as unknown as string[])}
      RETURNING id`) as unknown as unknown[];
    return rows.length > 0;
  }

  const rows = (await sql`
    UPDATE calls SET status = ${target}::call_status
     WHERE id = ${callId}
       AND status IN ${sql(from as unknown as string[])}
    RETURNING id`) as unknown as unknown[];
  return rows.length > 0;
}

/** One sweep row: a non-terminal call and its bot + owning tenant. */
interface SweepRow {
  id: string;
  tenant_id: string;
  recall_bot_id: string;
}

/** Append one `audit_log` row (privileged infra write — the #79 audit shape). */
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
 * Start the status-poller sweep (issue #118). Modeled on the #81 watchdog
 * scheduler: bounded, injectable interval/schedule, `tick()` as the testable
 * unit, `stop()` to halt. Each tick SELECTs the non-terminal calls that have a
 * `recall_bot_id`, polls each bot's status, and applies the resolved transition
 * with its §5.9 side effects + live status publish in ONE transaction; one
 * bot's failed lookup (or failed apply) is logged and skipped, never aborting
 * the sweep.
 */
export function startStatusPoller(deps: StatusPollerDeps): StatusPollerHandle {
  const { sql, source, actions } = deps;
  const clock = deps.clock ?? Date.now;
  let inFlight = false;

  /**
   * Apply one resolved transition. The status flip, its audit, the clean leave,
   * and the live status frame ride ONE transaction gated on `changed` (the
   * forward-only UPDATE is the persisted idempotency guard: a repeat poll matches
   * zero rows). The `pg_notify` is commit-gated and published LAST so an
   * in-memory test publisher only records committed changes.
   *
   * The §5.9 recording disclosure is the exception: it is a NON-idempotent
   * external POST, so it does NOT ride this tx (a post-send rollback would
   * re-post it every sweep — the samorev-gate finding). It runs OUTSIDE the tx,
   * driven by the durable `disclosure_posted_at` marker (see
   * {@link postDisclosureOnce}).
   */
  async function applyResolved(row: SweepRow, transition: PolledTransition, latest: StatusChange) {
    let applied = false;
    await sql.begin(async (tx) => {
      const exec = tx as unknown as SQL;
      const changed = await applyForward(exec, row.id, transition.status, latest.sub_code ?? null);
      if (!changed) return;
      applied = true;

      await audit(
        exec,
        row.tenant_id,
        row.id,
        "system",
        `call.status.${transition.status}`,
        sha256Hex(JSON.stringify(latest)),
      );

      // The clean leave (§5.9) is idempotent — leaving an absent bot is a no-op —
      // so it safely rides the status-flip tx, guarded by `changed`.
      if (transition.leave) {
        await actions.leave(row.recall_bot_id);
        await audit(exec, row.tenant_id, row.id, "bot", "call.leave", null);
      }

      // Live status push (#106): the SAME per-call channel/payload the
      // transcript path uses — `{k:"ctl",frame}` on `transcript:<call_id>`.
      if (deps.publisher) {
        const frame: TranscriptControlFrame = {
          type: "status",
          call_id: row.id,
          status: transition.status,
        };
        if (
          (transition.status === "COULD_NOT_JOIN" || transition.status === "COULD_NOT_RECORD") &&
          latest.sub_code
        ) {
          frame.reason = latest.sub_code;
        }
        await deps.publisher.publish(frame, exec);
      }
    });

    // §5.11 bot_join_total{result} (issue #107): emit ONCE per call on the
    // committed forward-only terminal transition. `applied` is set only when the
    // conditional UPDATE matched a row, so a duplicate poll (0 rows) never
    // double-counts, and it fires only after the tx COMMITS (a rollback throws
    // out of sql.begin and skips this). Carries the outcome label only, no key.
    if (applied) {
      const result = BOT_JOIN_RESULT_BY_STATUS[transition.status];
      if (result) deps.metrics?.incBotJoin(result);
    }

    // §5.9 recording disclosure — OUTSIDE the status-flip tx, guarded by the
    // durable marker (driven by the marker, not `changed`, so a failed send
    // retries on a later sweep even though the status already committed).
    if (transition.postDisclosure) {
      await postDisclosureOnce(row);
    }
  }

  /**
   * Post the §5.9 recording disclosure at most once. Send-then-stamp: only send
   * when `disclosure_posted_at` is unset, then stamp it (auditing on the stamp).
   * A crash between send and stamp re-sends on the next sweep — a duplicate
   * bounded to that narrow window, the right bias for a consent disclosure
   * (never silently skipped). True exactly-once is impossible for a
   * non-idempotent external POST without a Recall-side idempotency key.
   */
  async function postDisclosureOnce(row: SweepRow): Promise<void> {
    const unposted = (await sql`
      SELECT 1 FROM calls WHERE id = ${row.id} AND disclosure_posted_at IS NULL`) as unknown as unknown[];
    if (unposted.length === 0) return; // already disclosed — never re-send
    await actions.sendChat(row.recall_bot_id, DISCLOSURE_TEXT);
    await sql.begin(async (tx) => {
      const exec = tx as unknown as SQL;
      const stamped = (await exec`
        UPDATE calls SET disclosure_posted_at = now()
         WHERE id = ${row.id} AND disclosure_posted_at IS NULL
        RETURNING id`) as unknown as unknown[];
      if (stamped.length > 0) {
        await audit(exec, row.tenant_id, row.id, "bot", "call.disclosure", sha256Hex(DISCLOSURE_TEXT));
      }
    });
  }

  async function tick(): Promise<void> {
    if (inFlight) return; // never overlap sweeps (a slow Recall can outlast 10 s)
    inFlight = true;
    try {
      const rows = (await sql`
        SELECT id, tenant_id, recall_bot_id
          FROM calls
         WHERE status IN ${sql(NON_TERMINAL as unknown as string[])}
           AND recall_bot_id IS NOT NULL`) as unknown as SweepRow[];

      for (const row of rows) {
        let changes: StatusChange[];
        try {
          changes = await source.getStatus(row.recall_bot_id);
        } catch (err) {
          deps.logger?.warn(
            `[status-poller] bot ${row.recall_bot_id} status lookup failed (call ${row.id}): ` +
              `${(err as Error).message} — retrying next sweep`,
          );
          continue;
        }
        const latest = latestChange(changes);
        if (!latest) continue;
        const transition = resolvePolledTransition(latest, clock());
        if (!transition) continue;
        try {
          await applyResolved(row, transition, latest);
        } catch (err) {
          // e.g. a failed §5.9 disclosure post — the tx rolled back; retry next
          // sweep. Message carries ids + the error only, NEVER key material.
          deps.logger?.warn(
            `[status-poller] applying ${transition.status} to call ${row.id} failed: ` +
              `${(err as Error).message} — rolled back, retrying next sweep`,
          );
          continue;
        }
      }
    } finally {
      inFlight = false;
    }
  }

  const scheduled = (deps.schedule ?? defaultSchedule)(
    () => void tick(),
    deps.intervalMs ?? STATUS_POLL_INTERVAL_MS,
  );

  return { tick, stop: () => scheduled.stop() };
}
