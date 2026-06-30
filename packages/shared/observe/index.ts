/**
 * @samograph/shared/observe — the §5.11 observability surface.
 *
 * A single in-process metrics registry that aggregates the counters the
 * call-path already emits, a Prometheus `/metrics` endpoint, the structured
 * JSON logger that enforces tenant/call context, and the pure activation-funnel
 * aggregator that feeds the §9 W1-activation dashboard.
 */
export {
  MetricsRegistry,
  COUNTER_SPECS,
  nearestRankPercentiles,
  type CounterName,
  type PickupLatencySummary,
} from "./registry.ts";

export {
  aggregateFunnel,
  FUNNEL_STAGES,
  type ActivationEvent,
  type FunnelSnapshot,
  type FunnelStage,
} from "./funnel.ts";

export {
  buildLogRecord,
  formatLogLine,
  createLogger,
  MissingLogContextError,
  type LogContext,
  type LogLevel,
  type StructuredLogRecord,
} from "./logger.ts";

export { metricsHttpHandler, METRICS_CONTENT_TYPE } from "./metrics-http.ts";
