/**
 * `bot_join_total{result}` producer seam (SPEC §5.11; issue #107).
 *
 * The §5.11 terminal-join-outcome counter is DEFINED + exposition-rendered by the
 * shared {@link MetricsRegistry} (`incBotJoin`), but — unlike the other five
 * §5.11 counters — it had no PRODUCER: nothing on the call path ever called it.
 * This tiny port is that producer's injection point.
 *
 * The orchestrator (the createBot join path, §5.2) and the status poller
 * (JOINING→IN_CALL / COULD_NOT_JOIN / COULD_NOT_RECORD, §5.9 / issue #118) take
 * a {@link BotJoinMetrics} and increment ONCE per call on each terminal outcome,
 * guarded by the forward-only status transition so duplicate poll events never
 * double-count.
 *
 * The interface is deliberately the single method the shared registry already
 * exposes, so the production `MetricsRegistry` instance is a drop-in
 * {@link BotJoinMetrics} — no adapter, no Recall key ever crosses this boundary
 * (this port carries only a coarse outcome label). Tests inject
 * {@link inMemoryBotJoinMetrics}.
 */

/** The three §5.11 `bot_join_total` label values (terminal join outcomes). */
export type BotJoinResult = "in_call" | "could_not_join" | "could_not_record";

/**
 * The bot-join outcome counter port. Matches `MetricsRegistry.incBotJoin(result)`
 * exactly, so the shared registry satisfies it structurally in production.
 */
export interface BotJoinMetrics {
  /** Increment `bot_join_total{result}` by one. */
  incBotJoin(result: string): void;
}

/** {@link inMemoryBotJoinMetrics} adds a synchronous read surface for assertions. */
export interface InMemoryBotJoinMetrics extends BotJoinMetrics {
  /** Current value of `bot_join_total{result}` (0 if never incremented). */
  get(result: string): number;
  /** The full label→count map (read-only view for exhaustive assertions). */
  readonly counts: ReadonlyMap<string, number>;
}

/** In-memory {@link BotJoinMetrics} fake for tests / local dev (no registry). */
export function inMemoryBotJoinMetrics(): InMemoryBotJoinMetrics {
  const counts = new Map<string, number>();
  return {
    counts,
    incBotJoin(result: string): void {
      counts.set(result, (counts.get(result) ?? 0) + 1);
    },
    get(result: string): number {
      return counts.get(result) ?? 0;
    },
  };
}
