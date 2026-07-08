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
 *   magic_link_clicked — the user's email has a `magic_links` row with
 *                        `status = 'consumed'` (the single-use callback consumed
 *                        it; §5.1, migration 0007). Keyed by email because
 *                        `magic_links` is the pre-tenant, pre-user table.
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
} from "../../../packages/shared/observe/funnel.ts";

/**
 * Emit one {@link ActivationEvent} per (user, stage-reached) pair, read from
 * Postgres. The pure aggregator collapses these to the furthest stage per user,
 * so emitting every reached stage (rather than only the furthest) is equivalent
 * and robust to non-contiguous data.
 */
export async function queryActivationEvents(sql: SQL): Promise<ActivationEvent[]> {
  const rows = (await sql`
    -- signup: every user (1:1 tenant; §5.10).
    SELECT u.id::text AS user_id, 'signup' AS stage
      FROM users u
    UNION ALL
    -- magic_link_clicked: a consumed single-use link for this email (§5.1).
    SELECT u.id::text, 'magic_link_clicked'
      FROM users u
     WHERE EXISTS (
       SELECT 1 FROM magic_links m
        WHERE lower(m.email) = lower(u.email) AND m.status = 'consumed')
    UNION ALL
    -- call_created: the user's tenant owns a call (§5.2).
    SELECT u.id::text, 'call_created'
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
     WHERE EXISTS (SELECT 1 FROM calls c WHERE c.tenant_id = t.id)
    UNION ALL
    -- first_line: a call has the first-transcript-line stamp (§5.2).
    SELECT u.id::text, 'first_line'
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
     WHERE EXISTS (
       SELECT 1 FROM calls c
        WHERE c.tenant_id = t.id AND c.first_line_at IS NOT NULL)
    UNION ALL
    -- streamed_30s: a call's transcript SPANS >= 30 s (documented proxy, §9).
    SELECT u.id::text, 'streamed_30s'
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
     WHERE EXISTS (
       SELECT 1 FROM calls c
        WHERE c.tenant_id = t.id
          AND (SELECT max(tr.ts) - min(tr.ts)
                 FROM transcripts tr
                WHERE tr.call_id = c.id) >= interval '30 seconds')
  `) as Array<{ user_id: string; stage: ActivationEvent["stage"] }>;

  return rows.map((r) => ({ userId: r.user_id, stage: r.stage }));
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
  opts: { refreshMs?: number; logger?: { error: (msg: string) => void } } = {},
): CachedFunnelSource {
  const refreshMs = opts.refreshMs ?? DEFAULT_FUNNEL_REFRESH_MS;
  let latest: FunnelSnapshot = aggregateFunnel([]);

  const refresh = async (): Promise<void> => {
    try {
      latest = await computeFunnelSnapshot(sql);
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
