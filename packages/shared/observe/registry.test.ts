import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "./registry.ts";
import { aggregateFunnel } from "./funnel.ts";

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
    // Seven magic-link users at the seven historical furthest stages.
    const out = r.renderPrometheus(
      aggregateFunnel([
        { userId: "u1", stage: "signup" },
        { userId: "u2", stage: "auth_completed" },
        { userId: "u2", stage: "signup" },
        { userId: "u3", stage: "signup" },
        { userId: "u3", stage: "call_created" },
        { userId: "u4", stage: "signup" },
        { userId: "u4", stage: "first_line" },
        { userId: "u5", stage: "signup" },
        { userId: "u5", stage: "streamed_30s" },
        { userId: "u6", stage: "signup" },
        { userId: "u6", stage: "streamed_30s" },
        { userId: "u7", stage: "signup" },
        { userId: "u7", stage: "streamed_30s" },
      ]),
    );
    expect(out).toContain('samograph_funnel_stage{stage="signup",method="magic_link"} 7');
    expect(out).toContain('samograph_funnel_stage{stage="streamed_30s",method="magic_link"} 3');
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

/**
 * The auth/observability surface S5-1 item 7 committed to (issue #222).
 *
 * `auth_google_start_total` and `auth_identity_linked_total` carry NO label, so
 * they are rendered UNCONDITIONALLY at 0: "Google sign-in linked nobody to an
 * existing account" has to be an observable zero, not an absent series.
 */
describe("S5-1 item 7 auth metrics — #222", () => {
  test("the unlabelled auth counters render at 0 before anything happens", () => {
    const out = new MetricsRegistry().renderPrometheus();
    expect(out).toContain("# TYPE auth_google_start_total counter");
    expect(out).toContain("auth_google_start_total 0");
    expect(out).toContain("# TYPE auth_identity_linked_total counter");
    expect(out).toContain("auth_identity_linked_total 0");
  });

  test("auth_google_start_total and auth_identity_linked_total count exactly", () => {
    const r = new MetricsRegistry();
    r.incGoogleStart();
    r.incGoogleStart();
    r.incIdentityLinked();
    expect(r.getScalar("auth_google_start_total")).toBe(2);
    expect(r.getScalar("auth_identity_linked_total")).toBe(1);
    const out = r.renderPrometheus();
    expect(out).toContain("auth_google_start_total 2");
    expect(out).toContain("auth_identity_linked_total 1");
  });

  test("auth_google_callback_total keys by result", () => {
    const r = new MetricsRegistry();
    r.incGoogleCallback("ok");
    r.incGoogleCallback("ok");
    r.incGoogleCallback("SAMO-AUTH-009");
    expect(r.get("auth_google_callback_total", "ok")).toBe(2);
    expect(r.get("auth_google_callback_total", "SAMO-AUTH-009")).toBe(1);
    const out = r.renderPrometheus();
    expect(out).toContain('auth_google_callback_total{result="ok"} 2');
    expect(out).toContain('auth_google_callback_total{result="SAMO-AUTH-009"} 1');
  });

  test("samograph_magic_link_status renders one series per set status", () => {
    const r = new MetricsRegistry();
    r.setMagicLinkStatus("outstanding", 4);
    r.setMagicLinkStatus("consumed", 6);
    r.setMagicLinkStatus("superseded", 2);
    const out = r.renderPrometheus();
    expect(out).toContain("# TYPE samograph_magic_link_status gauge");
    expect(out).toContain('samograph_magic_link_status{status="outstanding"} 4');
    expect(out).toContain('samograph_magic_link_status{status="consumed"} 6');
    expect(out).toContain('samograph_magic_link_status{status="superseded"} 2');
  });

  test("a gauge is SET (last value wins), never accumulated", () => {
    const r = new MetricsRegistry();
    r.setMagicLinkStatus("consumed", 6);
    r.setMagicLinkStatus("consumed", 9);
    expect(r.renderPrometheus()).toContain('samograph_magic_link_status{status="consumed"} 9');
  });

  test("the funnel block is per-method only — no unlabelled stage series", () => {
    const out = new MetricsRegistry().renderPrometheus(
      aggregateFunnel([
        { userId: "m1", stage: "signup", method: "magic_link" },
        { userId: "m1", stage: "call_created", method: "magic_link" },
        { userId: "g1", stage: "signup", method: "google" },
        { userId: "g1", stage: "call_created", method: "google" },
      ]),
    );
    expect(out).toContain('samograph_funnel_stage{stage="auth_completed",method="magic_link"} 1');
    expect(out).toContain('samograph_funnel_stage{stage="auth_completed",method="google"} 1');
    expect(out).not.toContain('samograph_funnel_stage{stage="auth_completed"}');
  });
});

describe("Calendar observability — #240 Slice 4", () => {
  test("exports exact low-cardinality counters and gauges", () => {
    const r = new MetricsRegistry();
    r.incCalendarConnectStart();
    r.incCalendarConnectCallback("ok");
    r.incCalendarDisconnect("ok");
    r.incCalendarSync("ok");
    r.incCalendarSyncEvents(7);
    r.setCalendarConnections("connected", 3);
    r.setCalendarConnections("broken", 1);
    r.setCalendarSyncAgeSeconds(42);
    const out = r.renderPrometheus();
    expect(out).toContain("calendar_connect_start_total 1");
    expect(out).toContain('calendar_connect_callback_total{result="ok"} 1');
    expect(out).toContain('calendar_disconnect_total{revocation_result="ok"} 1');
    expect(out).toContain('calendar_sync_total{result="ok"} 1');
    expect(out).toContain("calendar_sync_events_total 7");
    expect(out).toContain('calendar_connections{state="connected"} 3');
    expect(out).toContain('calendar_connections{state="broken"} 1');
    expect(out).toContain("calendar_sync_age_seconds 42");
    expect(out).toContain("connected_at for never-synced connections; 0 when none are connected");
  });
});
