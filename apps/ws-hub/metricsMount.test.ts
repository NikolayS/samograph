/**
 * §5.11 production wiring (issue #108): the composed live stack (ingest + ws-hub,
 * the `dev-live-server` entrypoint) injects ONE shared {@link MetricsRegistry}
 * into every counter port and mounts GET /metrics on the ingest server, so the
 * five §5.11 counters aggregate into a single scrape source per process.
 */
import { describe, it, expect } from "bun:test";
import type { SQL } from "bun";
import { MetricsRegistry, METRICS_CONTENT_TYPE } from "../../packages/shared/observe/index.ts";
import { inMemoryWebhookSecretProvider } from "../ingest/webhook.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { composeLiveStack } from "./liveBridge.ts";

const authDeps: StreamAuthDeps = {
  keyring: { current: { kid: "k", secret: "k".repeat(32) } },
  lookupSession: async () => null,
  lookupCallTenant: async () => null,
};

describe("composed live stack GET /metrics (issue #108, §5.11)", () => {
  it("serves the shared registry off the ingest server with exact lines", async () => {
    const registry = new MetricsRegistry();
    const stack = composeLiveStack({
      sql: {} as SQL,
      authDeps,
      secretProvider: inMemoryWebhookSecretProvider("dev"),
      registry,
      lookupCallByBotId: async () => null,
      lookupCallByIngestSecret: async () => null,
    });
    try {
      // Drive two of the five §5.11 counters through the injected shared registry.
      registry.incTranscriptLines("us-east");
      registry.incTunnelProbeFailed("eu-west");

      const res = await fetch(`${stack.ingest.url}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);

      const body = await res.text();
      expect(body).toContain(`transcript_lines_total{region="us-east"} 1`);
      expect(body).toContain(`tunnel_probe_failed_total{region="eu-west"} 1`);
    } finally {
      await stack.stop();
    }
  });
});
