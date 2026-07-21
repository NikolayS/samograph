/**
 * §5.11 production wiring (issue #108): the app-api composition mounts GET
 * /metrics off ONE injected shared {@link MetricsRegistry} — the same registry
 * the prod entrypoint hands the bot-join producer (poller + runJoinJob), so
 * `bot_join_total` and `pickup_latency_ms` are scrapeable from the app-api box.
 */
import { describe, it, expect } from "bun:test";
import type { SQL } from "bun";
import { MetricsRegistry, METRICS_CONTENT_TYPE } from "../../packages/shared/observe/index.ts";
import { createAppApi } from "./app.ts";

function appWithRegistry(registry?: MetricsRegistry) {
  return createAppApi({
    sql: {} as SQL,
    sessionSecret: "s".repeat(32),
    magicLinkKid: "k",
    magicLinkSecret: "m".repeat(32),
    tokenKeyring: { current: { kid: "t", secret: "t".repeat(32) } },
    emailSender: { async sendMagicLink() {}, async sendAccountDeletion() {} },
    webOrigin: "http://localhost:3000",
    enqueue: () => {},
    registry,
  });
}

describe("app-api GET /metrics (issue #108, §5.11)", () => {
  it("renders exact bot_join_total + pickup_latency_ms lines off the shared registry", async () => {
    const registry = new MetricsRegistry();
    const api = appWithRegistry(registry);

    // The bot-join producer (§5.2 poller) and the lifecycle latency observer both
    // write the SAME shared registry the entrypoint injects here.
    registry.incBotJoin("in_call");
    registry.observePickupLatencyMs(1200);

    const res = await api.fetch(new Request("http://app.local/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);

    const body = await res.text();
    expect(body).toContain(`bot_join_total{result="in_call"} 1`);
    expect(body).toContain(`pickup_latency_ms{quantile="0.5"} 1200`);
  });

  it("without an injected registry, /metrics is 404 (unchanged)", async () => {
    const api = appWithRegistry(undefined);
    const res = await api.fetch(new Request("http://app.local/metrics"));
    expect(res.status).toBe(404);
  });
});
