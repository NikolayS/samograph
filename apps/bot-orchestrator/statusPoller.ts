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
 * event mapping: here `in_call_not_recording` is a transient pre-recording hop
 * (→ JOINING) and the explicit `recording_permission_denied` code carries the
 * §5.9 COULD_NOT_RECORD outcome.
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

export interface StatusPollerDeps {
  /** PRIVILEGED infra connection (bypasses RLS — the sweep crosses tenants). */
  sql: SQL;
  /** The polled status channel (fake in tests; {@link liveBotStatusSource} live). */
  source: BotStatusSource;
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
  const from = NON_TERMINAL.filter((s) => RANK[s] < RANK[target]);
  if (from.length === 0) return false; // target is PENDING — nothing is below it

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

/**
 * Start the status-poller sweep (issue #118). Modeled on the #81 watchdog
 * scheduler: bounded, injectable interval/schedule, `tick()` as the testable
 * unit, `stop()` to halt. Each tick SELECTs the non-terminal calls that have a
 * `recall_bot_id`, polls each bot's status, and applies the mapped transition;
 * one bot's failed lookup is logged and skipped, never aborting the sweep.
 */
export function startStatusPoller(deps: StatusPollerDeps): StatusPollerHandle {
  const { sql, source } = deps;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return; // never overlap sweeps (a slow Recall can outlast 10 s)
    inFlight = true;
    try {
      const rows = (await sql`
        SELECT id, recall_bot_id
          FROM calls
         WHERE status IN ${sql(NON_TERMINAL as unknown as string[])}
           AND recall_bot_id IS NOT NULL`) as unknown as Array<{
        id: string;
        recall_bot_id: string;
      }>;

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
        const target = mapPolledCode(latest.code);
        if (!target) continue;
        await applyForward(sql, row.id, target, latest.sub_code ?? null);
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
