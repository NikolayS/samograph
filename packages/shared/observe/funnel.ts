/**
 * Activation-funnel aggregator (SPEC §5.11 dashboard, §9 success metric).
 *
 * The single v1 success metric is **W1 activation** (§9): the fraction of new
 * signups who, within their first week, (a) paste a meeting link, (b) get the
 * bot admitted into a real call (Recall `in_call_recording`), and (c) watch
 * ≥ 30 s of live transcript stream. The funnel that feeds the dashboard has five
 * ordered stages (§5.11):
 *
 *   signup → auth completed → call created → first transcript line → 30 s of stream
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

/**
 * The five ordered funnel stages (§5.11). Index = depth.
 *
 * Stage 2 is `auth_completed`, NOT `magic_link_clicked` (SPEC amendment S5-1
 * item 7; issue #222). The old name encoded ONE credential path into the name of
 * a stage that means "this user finished authenticating". Once Google sign-in
 * landed, the derivation behind it (a consumed `magic_links` row) stopped being
 * reachable for a whole population of real users — and because this funnel is
 * CUMULATIVE, a Google user who got as far as `call_created` had stage 2
 * back-filled anyway, IMPUTING a magic-link click that never happened. Nothing
 * broke; the number was simply wrong, which is worse. The arity stays 5, so
 * every index/back-fill computation below is unchanged.
 */
export const FUNNEL_STAGES = [
  "signup",
  "auth_completed",
  "call_created",
  "first_line",
  "streamed_30s",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/**
 * How an account was CREATED — the `method` label on `samograph_funnel_stage`
 * and `samograph_activation_w1_by_method` (S5-1 item 7).
 *
 * This MIRRORS `SignupMethod` in `apps/app-api/auth/types.ts`, which is the
 * domain owner and the source of the `users.signup_method` CHECK (migration
 * 0012). The shared layer must not import from an app (same rule that duplicates
 * `nearestRankPercentiles` in registry.ts), so the two lists are held in sync by
 * a COMPILE-TIME mutual-assignability check in `apps/app-api/auth/stores.test.ts`
 * rather than by hope: adding a value on one side without the other fails
 * `bunx tsc --noEmit`.
 */
export const SIGNUP_METHODS = ["magic_link", "google"] as const;

export type SignupMethod = (typeof SIGNUP_METHODS)[number];

/**
 * The method attributed to an event that carries none — and the DDL default for
 * `users.signup_method` on rows that predate migration 0012. Both answers have
 * to be the same string or the metric would disagree with the column: every row
 * written before Google sign-in existed was a magic-link signup by construction.
 */
export const DEFAULT_SIGNUP_METHOD: SignupMethod = "magic_link";

/** One activation event: a user reached a given funnel stage. */
export interface ActivationEvent {
  /** Stable identity of the signing-up user. */
  userId: string;
  /** The stage reached. */
  stage: FunnelStage;
  /** How the account was created; {@link DEFAULT_SIGNUP_METHOD} when absent. */
  method?: SignupMethod;
}

/** One funnel, aggregated: the counts plus the §9 W1 fraction over them. */
export interface MethodFunnel {
  /** Cumulative count of users who reached AT LEAST each stage. */
  stageCounts: Record<FunnelStage, number>;
  /** Distinct signups (denominator of the W1 fraction). */
  total: number;
  /** Users who reached `streamed_30s` (numerator of the W1 fraction). */
  activated: number;
  /** W1 activation = activated / total (0 when there are no signups). */
  w1Fraction: number;
}

/** Aggregated funnel + the W1-activation fraction (§9), blended and per method. */
export interface FunnelSnapshot extends MethodFunnel {
  /**
   * The SAME funnel, computed independently per signup method — every method
   * always present, zeroed when unused, so a scrape never has a missing series.
   *
   * §9 re-baselining (S5-1 item 7) needs this: for the first full week after
   * Google ships, the `>= 0.5` W1 target is judged against
   * `method="magic_link"` and the blended number is reported but not targeted.
   * One-click signup raises the denominator faster than the numerator, so the
   * headline metric can FALL while the product improves — unreadable without
   * the split.
   */
  byMethod: Record<SignupMethod, MethodFunnel>;
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
  // user → { furthest stage index reached, signup method }.
  const furthest = new Map<string, { depth: number; method: SignupMethod }>();
  for (const { userId, stage, method } of events) {
    const idx = STAGE_INDEX[stage];
    const prev = furthest.get(userId);
    // The method is a property of the USER, not of the event: the DB feed stamps
    // the same `users.signup_method` on every row it emits for a user. Taking
    // the LAST non-default answer would make the result order-dependent, so the
    // FIRST explicit method a user is seen with wins and the rest are ignored —
    // aggregation stays order-independent (see the shuffle test).
    if (prev === undefined) {
      furthest.set(userId, { depth: idx, method: method ?? DEFAULT_SIGNUP_METHOD });
    } else if (idx > prev.depth) {
      prev.depth = idx;
    }
  }

  const zeroed = (): Record<FunnelStage, number> =>
    Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as Record<FunnelStage, number>;

  const stageCounts = zeroed();
  const perMethodCounts = Object.fromEntries(
    SIGNUP_METHODS.map((m) => [m, zeroed()]),
  ) as Record<SignupMethod, Record<FunnelStage, number>>;

  for (const { depth, method } of furthest.values()) {
    // Reaching stage `depth` implies every earlier stage (cumulative funnel).
    for (let i = 0; i <= depth; i++) {
      const stage = FUNNEL_STAGES[i]!;
      stageCounts[stage]++;
      perMethodCounts[method][stage]++;
    }
  }

  const summarize = (counts: Record<FunnelStage, number>): MethodFunnel => {
    const total = counts.signup;
    const activated = counts.streamed_30s;
    return { stageCounts: counts, total, activated, w1Fraction: total === 0 ? 0 : activated / total };
  };

  const byMethod = Object.fromEntries(
    SIGNUP_METHODS.map((m) => [m, summarize(perMethodCounts[m])]),
  ) as Record<SignupMethod, MethodFunnel>;

  return { ...summarize(stageCounts), byMethod };
}
