/**
 * DB-backed activation-funnel data source (SPEC §5.11 + §9; issue #16).
 *
 * This is the production feed for THE v1 success metric (§9). It reads the
 * activation stages straight out of Postgres and folds them through the PURE,
 * already-tested aggregator (`packages/shared/observe/funnel.ts`) so the counts
 * exposed at `GET /metrics` are the same monotonic, cumulative funnel the
 * dashboard renders.
 *
 * ── Stage → SQL signal mapping (§5.11) ─────────────────────────────────────
 *   signup             — a `users` row exists (every user has a 1:1 `tenants`
 *                        row; §5.10). This is the W1 denominator.
 *   auth_completed     — the user finished authenticating down EITHER credential
 *                        path: a `magic_links` row with `status = 'consumed'`
 *                        (§5.1, migration 0007; keyed by email because
 *                        `magic_links` is the pre-tenant, pre-user table) OR a
 *                        `user_identities` row (§5.1, migration 0011 — Google).
 *                        A `users` row with NEITHER is real and is NOT counted
 *                        here: issue #180 provisions the user BEFORE consuming
 *                        the link, so a failed consume leaves exactly that.
 *   call_created       — the user's tenant owns at least one `calls` row (§5.2).
 *   first_line         — one of those calls has `calls.first_line_at` set — the
 *                        exact "first transcript line landed" stamp (§5.2).
 *   streamed_30s       — one of those calls has a transcript that SPANS ≥ 30 s,
 *                        i.e. `max(transcripts.ts) - min(transcripts.ts) ≥ 30s`.
 *
 * ── APPROXIMATION (streamed_30s) — documented per §6.2 / the issue ─────────
 * The §9 definition of activation is "watched ≥ 30 s of live transcript
 * stream". v1 does not persist a per-viewer stream-watch duration, so we use the
 * best available server-side proxy: the WALL-CLOCK SPAN of a call's transcript
 * (last line ts − first line ts). This over-counts a call whose transcript
 * covers ≥ 30 s but that no human watched live, and under-counts a call watched
 * live for ≥ 30 s of SILENCE (< 2 transcript lines, so span is 0/NULL). It is a
 * deliberately conservative, PII-free approximation computed from timestamps
 * already stored for the transcript itself; when a real viewer-watch signal
 * lands (post-v1) this predicate is the single line to swap. The funnel stays
 * monotonic: a call that reaches `streamed_30s` still counts at `first_line`
 * even when `first_line_at` is NULL (silent-call convention, funnel.ts).
 *
 * ── The imputation bug this feed used to have (S5-1 item 7, issue #222) ────
 * Stage 2 was called `magic_link_clicked` and was derived from a consumed
 * `magic_links` row and NOTHING ELSE. A Google signup never produces one — the
 * callback writes `users` + `user_identities` only. But this funnel is
 * CUMULATIVE, so a Google user who reached `call_created` had stage 2 back-filled
 * anyway: a magic-link click that never happened, IMPUTED, silently, into THE v1
 * success metric. Nothing 500'd and no test went red, which is why it survived a
 * whole merged sequence. The over-count was exactly the Google-only users whose
 * furthest stage was at or beyond `call_created`; a Google user who signed up and
 * stopped had `furthest = 0` and was already counted correctly. The stage is now
 * `auth_completed` and reads BOTH credential tables, and every row carries
 * `users.signup_method` (migration 0012) so the metric can be split by `method`.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * Every query is a read-only COUNT/EXISTS aggregate over the PRIVILEGED
 * connection (the same pre-tenant handle auth uses — `users`/`tenants`/
 * `magic_links` are not on the tenant-scoped RLS surface). Only per-stage COUNTS
 * ever leave this module; no email, id, or meeting URL is exposed at /metrics.
 *
 * ── Scrape shape ────────────────────────────────────────────────────────────
 * `metricsHttpHandler` renders synchronously, so the scrape thunk must be sync.
 * A DB query is async, so {@link createCachedFunnelSource} keeps the LATEST
 * snapshot in memory and refreshes it on an interval (Prometheus collector
 * pattern): the scrape returns the cached snapshot; a background timer (and the
 * initial `start()`) recomputes it from the DB.
 */
import type { SQL } from "bun";
import {
  aggregateFunnel,
  type ActivationEvent,
  type FunnelSnapshot,
  type SignupMethod,
} from "../../../packages/shared/observe/funnel.ts";
import type { MagicLinkStatus } from "../auth/types.ts";

/**
 * Every magic-link lifecycle status, exhaustively (§5.1). The `Record` type is
 * the point: adding a `MagicLinkStatus` without adding it here fails
 * `bunx tsc --noEmit`, so `samograph_magic_link_status` can never quietly stop
 * reporting a state.
 */
const ZERO_MAGIC_LINK_STATUS: Record<MagicLinkStatus, number> = {
  outstanding: 0,
  consumed: 0,
  superseded: 0,
};

/** The §5.11 gauge sink this feed writes into (satisfied by `MetricsRegistry`). */
export interface MagicLinkStatusMetrics {
  setMagicLinkStatus(status: string, count: number): void;
}

/**
 * Count magic links by lifecycle status (`samograph_magic_link_status`, S5-1
 * item 7). Counts only — no email, no jti ever leaves this function. Statuses
 * with no rows are reported as an explicit 0 rather than omitted: "nothing is
 * outstanding" and "the scrape is broken" must not look the same.
 */
export async function queryMagicLinkStatusCounts(
  sql: SQL,
): Promise<Record<MagicLinkStatus, number>> {
  const rows = (await sql`
    SELECT status::text AS status, count(*)::int AS count
      FROM magic_links
     GROUP BY status`) as Array<{ status: MagicLinkStatus; count: number }>;
  const counts = { ...ZERO_MAGIC_LINK_STATUS };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/**
 * Emit one {@link ActivationEvent} per (user, stage-reached) pair, read from
 * Postgres. The pure aggregator collapses these to the furthest stage per user,
 * so emitting every reached stage (rather than only the furthest) is equivalent
 * and robust to non-contiguous data.
 */
export async function queryActivationEvents(sql: SQL): Promise<ActivationEvent[]> {
  const rows = (await sql`
    -- signup: every user (1:1 tenant; §5.10).
    SELECT u.id::text AS user_id, 'signup' AS stage, u.signup_method AS method
      FROM users u
    UNION ALL
    -- auth_completed: EITHER credential path finished (§5.1). A consumed
    -- single-use magic link (0007) OR a linked provider identity (0011) — the
    -- Google callback writes only the latter, and deriving this stage from
    -- magic links alone is what imputed a click that never happened (#222).
    SELECT u.id::text, 'auth_completed', u.signup_method
      FROM users u
     WHERE EXISTS (
             SELECT 1 FROM magic_links m
              WHERE lower(m.email) = lower(u.email) AND m.status = 'consumed')
        OR EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)
    UNION ALL
    -- call_created: the user's tenant owns a call (§5.2).
    SELECT u.id::text, 'call_created', u.signup_method
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
     WHERE EXISTS (SELECT 1 FROM calls c WHERE c.tenant_id = t.id)
    UNION ALL
    -- first_line: a call has the first-transcript-line stamp (§5.2).
    SELECT u.id::text, 'first_line', u.signup_method
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
     WHERE EXISTS (
       SELECT 1 FROM calls c
        WHERE c.tenant_id = t.id AND c.first_line_at IS NOT NULL)
    UNION ALL
    -- streamed_30s: a call's transcript SPANS >= 30 s (documented proxy, §9).
    SELECT u.id::text, 'streamed_30s', u.signup_method
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
     WHERE EXISTS (
       SELECT 1 FROM calls c
        WHERE c.tenant_id = t.id
          AND (SELECT max(tr.ts) - min(tr.ts)
                 FROM transcripts tr
                WHERE tr.call_id = c.id) >= interval '30 seconds')
  `) as Array<{
    user_id: string;
    stage: ActivationEvent["stage"];
    method: SignupMethod;
  }>;

  return rows.map((r) => ({ userId: r.user_id, stage: r.stage, method: r.method }));
}

/** Compute the exact activation-funnel snapshot from the DB right now. */
export async function computeFunnelSnapshot(sql: SQL): Promise<FunnelSnapshot> {
  return aggregateFunnel(await queryActivationEvents(sql));
}

/** A cached, self-refreshing funnel source for the synchronous /metrics scrape. */
export interface CachedFunnelSource {
  /** Synchronous scrape thunk: the LATEST computed snapshot (never throws). */
  thunk: () => FunnelSnapshot;
  /** Recompute the cached snapshot from the DB. */
  refresh: () => Promise<void>;
  /** Refresh once now, then every `refreshMs`. Returns a stop function. */
  start: () => () => void;
}

/** Default background refresh cadence for the funnel snapshot (30 s). */
export const DEFAULT_FUNNEL_REFRESH_MS = 30_000;

/**
 * Build a {@link CachedFunnelSource} over `sql`. The cache starts at the empty
 * funnel (all zeros) so a scrape before the first refresh is well-defined. A
 * failed refresh is swallowed (logged) and leaves the last good snapshot in
 * place — a transient DB blip must not 500 the /metrics scrape.
 */
export function createCachedFunnelSource(
  sql: SQL,
  opts: {
    refreshMs?: number;
    logger?: { error: (msg: string) => void };
    /**
     * When supplied, the same refresh also republishes
     * `samograph_magic_link_status` (S5-1 item 7). It rides THIS timer rather
     * than a second one because it is the same kind of thing — a periodic
     * counts-only read on the privileged connection — and two timers would be
     * two places to forget to start.
     */
    registry?: MagicLinkStatusMetrics;
  } = {},
): CachedFunnelSource {
  const refreshMs = opts.refreshMs ?? DEFAULT_FUNNEL_REFRESH_MS;
  let latest: FunnelSnapshot = aggregateFunnel([]);

  const refresh = async (): Promise<void> => {
    try {
      latest = await computeFunnelSnapshot(sql);
      if (opts.registry) {
        const counts = await queryMagicLinkStatusCounts(sql);
        for (const [status, count] of Object.entries(counts)) {
          opts.registry.setMagicLinkStatus(status, count);
        }
      }
    } catch (err) {
      opts.logger?.error(
        `[funnel] activation-funnel refresh failed; serving last snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  return {
    thunk: () => latest,
    refresh,
    start: () => {
      void refresh();
      const timer = setInterval(() => void refresh(), refreshMs);
      // Never keep the process alive for a metrics refresh.
      (timer as { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    },
  };
}
