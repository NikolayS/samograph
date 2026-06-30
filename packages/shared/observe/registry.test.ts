import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "./registry.ts";

/**
 * §5.11 counters — a single in-process aggregation surface for the counters the
 * call-path components already emit:
 *   bot_join_total{result}, transcript_lines_total{region},
 *   ws_dropped_total{call_id}, tunnel_probe_failed_total{region},
 *   webhook_rejected_total{reason}, pickup_latency_ms{p50,p95,p99}.
 *
 * Tests assert EXACT aggregated values + exact Prometheus exposition lines, not
 * mere existence.
 */
describe("MetricsRegistry counters — §5.11", () => {
  test("bot_join_total separates results by label", () => {
    const r = new MetricsRegistry();
    r.incBotJoin("in_call");
    r.incBotJoin("in_call");
    r.incBotJoin("could_not_record");
    expect(r.get("bot_join_total", "in_call")).toBe(2);
    expect(r.get("bot_join_total", "could_not_record")).toBe(1);
    expect(r.get("bot_join_total", "could_not_join")).toBe(0);
  });

  test("transcript_lines_total and tunnel_probe_failed_total key by region", () => {
    const r = new MetricsRegistry();
    r.incTranscriptLines("eu-central");
    r.incTranscriptLines("eu-central");
    r.incTranscriptLines("us-east");
    r.incTunnelProbeFailed("eu-central");
    expect(r.get("transcript_lines_total", "eu-central")).toBe(2);
    expect(r.get("transcript_lines_total", "us-east")).toBe(1);
    expect(r.get("tunnel_probe_failed_total", "eu-central")).toBe(1);
    expect(r.get("tunnel_probe_failed_total", "us-east")).toBe(0);
  });

  test("webhook_rejected_total keys by reason", () => {
    const r = new MetricsRegistry();
    r.incRejected("bad_signature");
    r.incRejected("bad_signature");
    r.incRejected("cross_tenant");
    expect(r.get("webhook_rejected_total", "bad_signature")).toBe(2);
    expect(r.get("webhook_rejected_total", "cross_tenant")).toBe(1);
  });

  test("ws_dropped_total keys by call_id and accepts a drop count", () => {
    const r = new MetricsRegistry();
    r.incWsDropped("call-a", 3);
    r.incWsDropped("call-a", 2);
    r.incWsDropped("call-b");
    expect(r.get("ws_dropped_total", "call-a")).toBe(5);
    expect(r.get("ws_dropped_total", "call-b")).toBe(1);
  });

  test("pickup_latency_ms exports nearest-rank p50/p95/p99 deterministically", () => {
    const r = new MetricsRegistry();
    // sample 1..100 → nearest-rank p50=50, p95=95, p99=99.
    for (let v = 1; v <= 100; v++) r.observePickupLatencyMs(v);
    expect(r.pickupLatency()).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  test("pickup_latency_ms on an empty sample is all zeros", () => {
    expect(new MetricsRegistry().pickupLatency()).toEqual({ p50: 0, p95: 0, p99: 0 });
  });
});

describe("MetricsRegistry Prometheus exposition — §5.11", () => {
  test("renders exact counter lines with HELP/TYPE headers", () => {
    const r = new MetricsRegistry();
    r.incBotJoin("in_call");
    r.incBotJoin("in_call");
    r.incRejected("bad_signature");
    const out = r.renderPrometheus();
    expect(out).toContain("# TYPE bot_join_total counter");
    expect(out).toContain('bot_join_total{result="in_call"} 2');
    expect(out).toContain('webhook_rejected_total{reason="bad_signature"} 1');
  });

  test("renders pickup_latency_ms as quantile summary", () => {
    const r = new MetricsRegistry();
    for (let v = 1; v <= 100; v++) r.observePickupLatencyMs(v);
    const out = r.renderPrometheus();
    expect(out).toContain("# TYPE pickup_latency_ms summary");
    expect(out).toContain('pickup_latency_ms{quantile="0.5"} 50');
    expect(out).toContain('pickup_latency_ms{quantile="0.95"} 95');
    expect(out).toContain('pickup_latency_ms{quantile="0.99"} 99');
  });

  test("renders the activation funnel gauges when a snapshot is provided", () => {
    const r = new MetricsRegistry();
    const out = r.renderPrometheus({
      stageCounts: {
        signup: 7,
        magic_link_clicked: 6,
        call_created: 5,
        first_line: 4,
        streamed_30s: 3,
      },
      total: 7,
      activated: 3,
      w1Fraction: 3 / 7,
    });
    expect(out).toContain('samograph_funnel_stage{stage="signup"} 7');
    expect(out).toContain('samograph_funnel_stage{stage="streamed_30s"} 3');
    expect(out).toContain("samograph_funnel_total 7");
    expect(out).toContain("samograph_funnel_activated 3");
    expect(out).toMatch(/samograph_activation_w1 0\.4285/);
  });

  test("escapes label values safely", () => {
    const r = new MetricsRegistry();
    r.incWsDropped('call"x\\y', 1);
    const out = r.renderPrometheus();
    expect(out).toContain('ws_dropped_total{call_id="call\\"x\\\\y"} 1');
  });
});
