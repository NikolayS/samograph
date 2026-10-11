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
  SCALAR_COUNTER_SPECS,
  GAUGE_SPECS,
  nearestRankPercentiles,
  type CounterName,
  type ScalarCounterName,
  type GaugeName,
  type PickupLatencySummary,
} from "./registry.ts";

export {
  aggregateFunnel,
  DEFAULT_SIGNUP_METHOD,
  FUNNEL_STAGES,
  SIGNUP_METHODS,
  type ActivationEvent,
  type FunnelSnapshot,
  type FunnelStage,
  type MethodFunnel,
  type SignupMethod,
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
