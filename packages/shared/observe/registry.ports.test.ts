import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "./registry.ts";
import type {
  TranscriptMetrics,
  WatchdogMetrics,
  WebhookMetrics,
  BotLifecycleMetrics,
} from "../../../apps/ingest/index.ts";

/**
 * The registry is the AGGREGATION point for counters the call-path already
 * emits: it must be a drop-in for each component's existing counter PORT
 * interface (ingest #78/#79/#81, webhook #77). This test pins that structural
 * compatibility — if a port shape drifts, this fails to compile/run — and proves
 * increments driven through the port-typed reference land in the aggregate.
 */
describe("MetricsRegistry satisfies the call-path counter ports — §5.11", () => {
  test("is a TranscriptMetrics (transcript_lines_total)", () => {
    const r = new MetricsRegistry();
    const port: TranscriptMetrics = r;
    port.incTranscriptLines("eu-central");
    port.incTranscriptLines("eu-central");
    expect(r.get("transcript_lines_total", "eu-central")).toBe(2);
  });

  test("is a WatchdogMetrics (tunnel_probe_failed_total)", () => {
    const r = new MetricsRegistry();
    const port: WatchdogMetrics = r;
    port.incTunnelProbeFailed("us-east");
    expect(r.get("tunnel_probe_failed_total", "us-east")).toBe(1);
  });

  test("is a WebhookMetrics (webhook_rejected_total)", () => {
    const r = new MetricsRegistry();
    const port: WebhookMetrics = r;
    port.incRejected("ingest_secret_mismatch");
    expect(r.get("webhook_rejected_total", "ingest_secret_mismatch")).toBe(1);
  });

  test("is a BotLifecycleMetrics (pickup_latency_ms)", () => {
    const r = new MetricsRegistry();
    const port: BotLifecycleMetrics = r;
    port.observePickupLatencyMs(42);
    port.observePickupLatencyMs(100);
    expect(r.pickupLatency().p99).toBe(100);
  });
});
