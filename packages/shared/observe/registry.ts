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
 * plus the sign-in surface SPEC amendment S5-1 item 7 added (issue #222):
 *
 *   auth_google_start_total           — accepted `/auth/google/start` requests
 *   auth_google_callback_total{result} — callbacks by `ok` / §5.16 code
 *   auth_identity_linked_total        — SILENT links to an existing account
 *   samograph_magic_link_status{status} — magic links by lifecycle status
 *
 * The increment methods are named to MATCH each component's existing counter
 * port (`incTranscriptLines`, `incTunnelProbeFailed`, `incRejected`,
 * `observePickupLatencyMs`), so one registry instance is a drop-in replacement
 * for the in-memory test fakes — the production wiring point. The registry also
 * renders the Prometheus text exposition consumed by the `/metrics` endpoint and
 * the committed Grafana dashboard (§5.11), optionally folding in the activation
 * funnel (§9).
 *
 * At most ONE label per series (most §5.11 counters have exactly one; two —
 * `auth_google_start_total` and `auth_identity_linked_total` — have none and are
 * therefore always rendered, at 0 if need be), which keeps the surface tiny and
 * the exposition deterministic. The activation funnel is the single exception:
 * its `{stage, method}` pair is rendered from the snapshot, not accumulated
 * here.
 */
import type { FunnelSnapshot } from "./funnel.ts";
import { FUNNEL_STAGES, SIGNUP_METHODS } from "./funnel.ts";

/** A §5.11 counter name → its single label key + HELP text. */
export const COUNTER_SPECS = {
  bot_join_total: { label: "result", help: "Bot join outcomes by terminal result." },
  transcript_lines_total: { label: "region", help: "Transcript lines ingested by region." },
  ws_dropped_total: { label: "call_id", help: "WS fan-out frames dropped by call." },
  tunnel_probe_failed_total: { label: "region", help: "Tunnel health-probe failures by region." },
  webhook_rejected_total: { label: "reason", help: "Webhook rejections by reason (§5.3)." },
  // S5-1 item 7 (issue #222). `result` is `ok` on success and the §5.16 error
  // code otherwise — a closed, tiny domain, so the cardinality stays bounded.
  auth_google_callback_total: {
    label: "result",
    help: "Google sign-in callbacks by result (`ok` or the §5.16 code).",
  },
  calendar_connect_callback_total: { label: "result", help: "Calendar OAuth callbacks by result." },
  calendar_disconnect_total: { label: "revocation_result", help: "Calendar disconnects by revocation result." },
  calendar_sync_total: { label: "result", help: "Calendar connection syncs by result." },
  calendar_autojoin_total: { label: "result", help: "Calendar auto-join outcomes by result." },
} as const;

export type CounterName = keyof typeof COUNTER_SPECS;

/**
 * Counters with NO label (S5-1 item 7, issue #222).
 *
 * These are rendered UNCONDITIONALLY, including at 0. "Google sign-in has linked
 * nobody to an existing account" is a fact a dashboard has to be able to READ;
 * an absent series is indistinguishable from a broken scrape, and the silent
 * link (S5-1 item 5) is precisely the event whose absence must be visible.
 */
export const SCALAR_COUNTER_SPECS = {
  auth_google_start_total: { help: "`GET /auth/google/start` requests accepted." },
  auth_identity_linked_total: {
    help: "Google identities SILENTLY linked to an already-existing account (S5-1 item 5).",
  },
  calendar_connect_start_total: { help: "Calendar OAuth starts accepted." },
  calendar_sync_events_total: { help: "Calendar events reconciled successfully." },
} as const;

export type ScalarCounterName = keyof typeof SCALAR_COUNTER_SPECS;

/**
 * Point-in-time gauges: a value that is SET from a periodic read, never
 * accumulated. `samograph_magic_link_status` is the magic-link lifecycle
 * (§5.1 / `MagicLinkStatus`) counted straight out of Postgres by the app's
 * funnel refresh, so a stuck `outstanding` pile is visible.
 */
export const GAUGE_SPECS = {
  samograph_magic_link_status: {
    label: "status",
    help: "Magic links by lifecycle status (outstanding/consumed/superseded, §5.1).",
  },
  calendar_connections: { label: "state", help: "Calendar connections by state." },
} as const;

export type GaugeName = keyof typeof GAUGE_SPECS;

export const SCALAR_GAUGE_SPECS = {
  calendar_sync_age_seconds: { help: "Age of the oldest connected Calendar synchronization, using connected_at for never-synced connections; 0 when none are connected." },
} as const;
export type ScalarGaugeName = keyof typeof SCALAR_GAUGE_SPECS;

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
  /** Label-less counters; every declared name starts at 0 and is always rendered. */
  private readonly scalarCounters = new Map<ScalarCounterName, number>();
  /** name → (label value → last SET value). */
  private readonly gauges = new Map<GaugeName, Map<string, number>>();
  private readonly scalarGauges = new Map<ScalarGaugeName, number>();
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

  // --- S5-1 item 7 auth surface (issue #222) ---
  // Named to MATCH `GoogleAuthMetrics` in apps/app-api/auth/google-service.ts,
  // so this registry is a drop-in for that port exactly as it is for the
  // call-path ports above.

  /** `auth_google_start_total` — one accepted `GET /auth/google/start`. */
  incGoogleStart(): void {
    this.bumpScalar("auth_google_start_total");
  }

  /** `auth_google_callback_total{result}` — `ok`, or the §5.16 error code. */
  incGoogleCallback(result: string): void {
    this.bump("auth_google_callback_total", result, 1);
  }

  /**
   * `auth_identity_linked_total` — a Google identity attached to an ALREADY
   * EXISTING account (S5-1 item 5). Never a new user, never a returning signer.
   */
  incIdentityLinked(): void {
    this.bumpScalar("auth_identity_linked_total");
  }

  incCalendarConnectStart(): void { this.bumpScalar("calendar_connect_start_total"); }
  incCalendarConnectCallback(result: string): void { this.bump("calendar_connect_callback_total", result, 1); }
  incCalendarDisconnect(result: string): void { this.bump("calendar_disconnect_total", result, 1); }
  incCalendarSync(result: string): void { this.bump("calendar_sync_total", result, 1); }
  incCalendarAutoJoin(result: string): void { this.bump("calendar_autojoin_total", result, 1); }
  incCalendarSyncEvents(by: number): void { this.bumpScalarBy("calendar_sync_events_total", by); }
  setCalendarConnections(state: string, count: number): void { this.setGauge("calendar_connections", state, count); }
  setCalendarSyncAgeSeconds(seconds: number): void { this.scalarGauges.set("calendar_sync_age_seconds", seconds); }

  /** `samograph_magic_link_status{status}` — SET from the periodic DB read. */
  setMagicLinkStatus(status: string, count: number): void {
    this.setGauge("samograph_magic_link_status", status, count);
  }

  /** Set a declared gauge series to `value` (last write wins — never additive). */
  setGauge(name: GaugeName, labelValue: string, value: number): void {
    let series = this.gauges.get(name);
    if (!series) {
      series = new Map();
      this.gauges.set(name, series);
    }
    series.set(labelValue, value);
  }

  private bumpScalar(name: ScalarCounterName): void {
    this.scalarCounters.set(name, (this.scalarCounters.get(name) ?? 0) + 1);
  }
  private bumpScalarBy(name: ScalarCounterName, by: number): void {
    this.scalarCounters.set(name, (this.scalarCounters.get(name) ?? 0) + by);
  }

  // --- read surface ---

  /** Current value of `name{label=value}` (0 if never incremented). */
  get(name: CounterName, labelValue: string): number {
    return this.counters.get(name)?.get(labelValue) ?? 0;
  }

  /** Current value of a label-less counter (0 if never incremented). */
  getScalar(name: ScalarCounterName): number {
    return this.scalarCounters.get(name) ?? 0;
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

    for (const name of Object.keys(SCALAR_COUNTER_SPECS) as ScalarCounterName[]) {
      lines.push(`# HELP ${name} ${SCALAR_COUNTER_SPECS[name].help}`);
      lines.push(`# TYPE ${name} counter`);
      // Always rendered, including at 0 — see SCALAR_COUNTER_SPECS.
      lines.push(`${name} ${this.getScalar(name)}`);
    }

    for (const name of Object.keys(GAUGE_SPECS) as GaugeName[]) {
      const spec = GAUGE_SPECS[name];
      lines.push(`# HELP ${name} ${spec.help}`);
      lines.push(`# TYPE ${name} gauge`);
      const series = this.gauges.get(name);
      if (series) {
        for (const labelValue of [...series.keys()].sort()) {
          lines.push(`${name}{${spec.label}="${escapeLabel(labelValue)}"} ${series.get(labelValue)}`);
        }
      }
    }

    for (const name of Object.keys(SCALAR_GAUGE_SPECS) as ScalarGaugeName[]) {
      lines.push(`# HELP ${name} ${SCALAR_GAUGE_SPECS[name].help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${this.scalarGauges.get(name) ?? 0}`);
    }

    const p = this.pickupLatency();
    lines.push("# HELP pickup_latency_ms Event-received → status-visible latency (§5.2).");
    lines.push("# TYPE pickup_latency_ms summary");
    lines.push(`pickup_latency_ms{quantile="0.5"} ${p.p50}`);
    lines.push(`pickup_latency_ms{quantile="0.95"} ${p.p95}`);
    lines.push(`pickup_latency_ms{quantile="0.99"} ${p.p99}`);

    if (funnel) {
      // PER-METHOD SERIES ONLY (S5-1 item 7): there is deliberately NO
      // unlabelled `samograph_funnel_stage{stage="…"}` series. A blended series
      // sitting next to the split ones is what invites a dashboard to sum the
      // two together and double-count every user; `sum by (stage)` recovers the
      // blend exactly, so nothing is lost by leaving it out.
      lines.push("# HELP samograph_funnel_stage Cumulative users reaching each activation stage, by signup method (§9).");
      lines.push("# TYPE samograph_funnel_stage gauge");
      for (const stage of FUNNEL_STAGES) {
        for (const method of SIGNUP_METHODS) {
          lines.push(
            `samograph_funnel_stage{stage="${stage}",method="${method}"} ${funnel.byMethod[method].stageCounts[stage]}`,
          );
        }
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
      // The §9 re-baselining series (S5-1 item 7): the `>= 0.5` target is judged
      // against `method="magic_link"` for the first full week after Google
      // ships, because one-click signup raises the denominator faster than the
      // numerator and the BLENDED number can fall while the product improves.
      lines.push("# HELP samograph_activation_w1_by_method W1 activation fraction per signup method (§9 re-baselining).");
      lines.push("# TYPE samograph_activation_w1_by_method gauge");
      for (const method of SIGNUP_METHODS) {
        lines.push(
          `samograph_activation_w1_by_method{method="${method}"} ${funnel.byMethod[method].w1Fraction}`,
        );
      }
    }

    return lines.join("\n") + "\n";
  }
}
