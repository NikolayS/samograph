/**
 * In-process metrics registry — the §5.11 observability surface.
 *
 * A single aggregation point for the counters the call-path components already
 * emit through their per-component ports (ingest #78/#79/#81, webhook #77,
 * ws-hub #82):
 *
 *   bot_join_total{result}            — terminal join outcome
 *   transcript_lines_total{region}    — normalized lines persisted/published
 *   ws_dropped_total{call_id}         — fan-out overflow drops (§5.5)
 *   tunnel_probe_failed_total{region} — watchdog probe failures (§4.5)
 *   webhook_rejected_total{reason}    — §5.3 fail-closed rejections
 *   pickup_latency_ms{p50,p95,p99}    — event-received → status-visible (§5.2)
 *
 * The increment methods are named to MATCH each component's existing counter
 * port (`incTranscriptLines`, `incTunnelProbeFailed`, `incRejected`,
 * `observePickupLatencyMs`), so one registry instance is a drop-in replacement
 * for the in-memory test fakes — the production wiring point. The registry also
 * renders the Prometheus text exposition consumed by the `/metrics` endpoint and
 * the committed Grafana dashboard (§5.11), optionally folding in the activation
 * funnel (§9).
 *
 * Single-label counters only (every §5.11 counter has exactly one label), which
 * keeps the surface tiny and the exposition deterministic.
 */
import type { FunnelSnapshot } from "./funnel.ts";
import { FUNNEL_STAGES } from "./funnel.ts";

/** A §5.11 counter name → its single label key + HELP text. */
export const COUNTER_SPECS = {
  bot_join_total: { label: "result", help: "Bot join outcomes by terminal result." },
  transcript_lines_total: { label: "region", help: "Transcript lines ingested by region." },
  ws_dropped_total: { label: "call_id", help: "WS fan-out frames dropped by call." },
  tunnel_probe_failed_total: { label: "region", help: "Tunnel health-probe failures by region." },
  webhook_rejected_total: { label: "reason", help: "Webhook rejections by reason (§5.3)." },
} as const;

export type CounterName = keyof typeof COUNTER_SPECS;

/** Nearest-rank pickup-latency percentiles (§5.11). */
export interface PickupLatencySummary {
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Nearest-rank p50/p95/p99 over a latency sample. Rank = `ceil(p/100·n)`
 * (1-indexed), clamped to the last element; an empty sample is all zeros.
 * Mirrors the ingest lifecycle's `pickupLatencyPercentiles` (§6.2 #8) so the
 * exported numbers match the SLO assertion's source of truth — shared layer must
 * not import from an app, so the (tiny, pure) algorithm is duplicated here.
 */
export function nearestRankPercentiles(samplesMs: readonly number[]): PickupLatencySummary {
  if (samplesMs.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  return { p50: at(50), p95: at(95), p99: at(99) };
}

/** Escape a Prometheus label value (`\`, `"`, newline) per the exposition format. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class MetricsRegistry {
  /** name → (label value → count). */
  private readonly counters = new Map<CounterName, Map<string, number>>();
  /** Raw pickup-latency sample (ms). */
  private readonly pickupSamples: number[] = [];

  private bump(name: CounterName, labelValue: string, by: number): void {
    let series = this.counters.get(name);
    if (!series) {
      series = new Map();
      this.counters.set(name, series);
    }
    series.set(labelValue, (series.get(labelValue) ?? 0) + by);
  }

  // --- increment surface (named to match the component ports) ---

  /** `bot_join_total{result}` — e.g. `in_call`, `could_not_record`, `could_not_join`. */
  incBotJoin(result: string): void {
    this.bump("bot_join_total", result, 1);
  }

  /** `transcript_lines_total{region}` — matches ingest's `TranscriptMetrics` port (#78). */
  incTranscriptLines(region: string): void {
    this.bump("transcript_lines_total", region, 1);
  }

  /** `ws_dropped_total{call_id}` — matches ws-hub's per-call drop counter (#82, §5.5). */
  incWsDropped(callId: string, by = 1): void {
    this.bump("ws_dropped_total", callId, by);
  }

  /** `tunnel_probe_failed_total{region}` — matches ingest's `WatchdogMetrics` port (#81). */
  incTunnelProbeFailed(region: string): void {
    this.bump("tunnel_probe_failed_total", region, 1);
  }

  /** `webhook_rejected_total{reason}` — matches ingest's `WebhookMetrics` port (#77). */
  incRejected(reason: string): void {
    this.bump("webhook_rejected_total", reason, 1);
  }

  /** `pickup_latency_ms` — matches ingest's `BotLifecycleMetrics` port (#79, §5.2). */
  observePickupLatencyMs(ms: number): void {
    this.pickupSamples.push(ms);
  }

  // --- read surface ---

  /** Current value of `name{label=value}` (0 if never incremented). */
  get(name: CounterName, labelValue: string): number {
    return this.counters.get(name)?.get(labelValue) ?? 0;
  }

  /** Nearest-rank pickup-latency p50/p95/p99 over the recorded sample. */
  pickupLatency(): PickupLatencySummary {
    return nearestRankPercentiles(this.pickupSamples);
  }

  /**
   * Render the Prometheus text exposition (counters + pickup-latency summary,
   * plus the activation-funnel gauges when a snapshot is supplied). Series are
   * emitted in a stable order so the output is deterministic.
   */
  renderPrometheus(funnel?: FunnelSnapshot): string {
    const lines: string[] = [];

    for (const name of Object.keys(COUNTER_SPECS) as CounterName[]) {
      const spec = COUNTER_SPECS[name];
      lines.push(`# HELP ${name} ${spec.help}`);
      lines.push(`# TYPE ${name} counter`);
      const series = this.counters.get(name);
      if (series) {
        for (const labelValue of [...series.keys()].sort()) {
          lines.push(`${name}{${spec.label}="${escapeLabel(labelValue)}"} ${series.get(labelValue)}`);
        }
      }
    }

    const p = this.pickupLatency();
    lines.push("# HELP pickup_latency_ms Event-received → status-visible latency (§5.2).");
    lines.push("# TYPE pickup_latency_ms summary");
    lines.push(`pickup_latency_ms{quantile="0.5"} ${p.p50}`);
    lines.push(`pickup_latency_ms{quantile="0.95"} ${p.p95}`);
    lines.push(`pickup_latency_ms{quantile="0.99"} ${p.p99}`);

    if (funnel) {
      lines.push("# HELP samograph_funnel_stage Cumulative users reaching each activation stage (§9).");
      lines.push("# TYPE samograph_funnel_stage gauge");
      for (const stage of FUNNEL_STAGES) {
        lines.push(`samograph_funnel_stage{stage="${stage}"} ${funnel.stageCounts[stage]}`);
      }
      lines.push("# HELP samograph_funnel_total Distinct signups (W1 denominator).");
      lines.push("# TYPE samograph_funnel_total gauge");
      lines.push(`samograph_funnel_total ${funnel.total}`);
      lines.push("# HELP samograph_funnel_activated Signups reaching 30 s of stream (W1 numerator).");
      lines.push("# TYPE samograph_funnel_activated gauge");
      lines.push(`samograph_funnel_activated ${funnel.activated}`);
      lines.push("# HELP samograph_activation_w1 W1 activation fraction (THE v1 metric, §9).");
      lines.push("# TYPE samograph_activation_w1 gauge");
      lines.push(`samograph_activation_w1 ${funnel.w1Fraction}`);
    }

    return lines.join("\n") + "\n";
  }
}
