/**
 * Activation-funnel aggregator (SPEC §5.11 dashboard, §9 success metric).
 *
 * The single v1 success metric is **W1 activation** (§9): the fraction of new
 * signups who, within their first week, (a) paste a meeting link, (b) get the
 * bot admitted into a real call (Recall `in_call_recording`), and (c) watch
 * ≥ 30 s of live transcript stream. The funnel that feeds the dashboard has five
 * ordered stages (§5.11):
 *
 *   signup → magic-link clicked → call created → first transcript line → 30 s of stream
 *
 * `first_line` is keyed off `calls.first_line_at` (§5.2). `streamed_30s` is keyed
 * off Recall `in_call_recording` + ≥ 30 s of stream, **not** the first line
 * (§9) — a silent call (admitted, no one speaks) still activates.
 *
 * This is a PURE function over a stream of activation events. It is a CUMULATIVE
 * funnel: each user is counted at every stage up to and including the FURTHEST
 * stage they reached, so `stageCounts[i]` is the count of users who reached at
 * least stage `i`. A user who is admitted but watches < 30 s is therefore
 * counted at their correct earlier stage and NOT at `streamed_30s`; a silent
 * call that reaches 30 s with no transcript line still counts at `first_line` by
 * the monotonic funnel convention.
 */

/** The five ordered funnel stages (§5.11). Index = depth. */
export const FUNNEL_STAGES = [
  "signup",
  "magic_link_clicked",
  "call_created",
  "first_line",
  "streamed_30s",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** One activation event: a user reached a given funnel stage. */
export interface ActivationEvent {
  /** Stable identity of the signing-up user. */
  userId: string;
  /** The stage reached. */
  stage: FunnelStage;
}

/** Aggregated funnel + the W1-activation fraction (§9). */
export interface FunnelSnapshot {
  /** Cumulative count of users who reached AT LEAST each stage. */
  stageCounts: Record<FunnelStage, number>;
  /** Distinct signups (denominator of the W1 fraction). */
  total: number;
  /** Users who reached `streamed_30s` (numerator of the W1 fraction). */
  activated: number;
  /** W1 activation = activated / total (0 when there are no signups). */
  w1Fraction: number;
}

const STAGE_INDEX: Record<FunnelStage, number> = Object.fromEntries(
  FUNNEL_STAGES.map((s, i) => [s, i]),
) as Record<FunnelStage, number>;

/**
 * Aggregate a stream of {@link ActivationEvent}s into a {@link FunnelSnapshot}.
 * Pure, order-independent, idempotent under duplicate events: each user's
 * contribution is the maximum (furthest) stage index they reached.
 */
export function aggregateFunnel(events: Iterable<ActivationEvent>): FunnelSnapshot {
  // user → furthest stage index reached.
  const furthest = new Map<string, number>();
  for (const { userId, stage } of events) {
    const idx = STAGE_INDEX[stage];
    const prev = furthest.get(userId);
    if (prev === undefined || idx > prev) furthest.set(userId, idx);
  }

  const stageCounts = Object.fromEntries(
    FUNNEL_STAGES.map((s) => [s, 0]),
  ) as Record<FunnelStage, number>;

  for (const depth of furthest.values()) {
    // Reaching stage `depth` implies every earlier stage (cumulative funnel).
    for (let i = 0; i <= depth; i++) stageCounts[FUNNEL_STAGES[i]!]++;
  }

  const total = stageCounts.signup;
  const activated = stageCounts.streamed_30s;
  const w1Fraction = total === 0 ? 0 : activated / total;

  return { stageCounts, total, activated, w1Fraction };
}
