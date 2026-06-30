import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "./registry.ts";
import { metricsHttpHandler } from "./metrics-http.ts";

/**
 * A `/metrics`-style read endpoint (§5.11) that renders the registry plus the
 * activation-funnel snapshot. Config-as-code; hosted provisioning is out of
 * scope (the Grafana dashboard JSON ships alongside).
 */
describe("metricsHttpHandler — §5.11", () => {
  const funnel = {
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
  };

  test("GET /metrics returns the Prometheus exposition", async () => {
    const r = new MetricsRegistry();
    r.incBotJoin("in_call");
    const handler = metricsHttpHandler(r, () => funnel);
    const res = handler(new Request("http://x/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain('bot_join_total{result="in_call"} 1');
    expect(body).toContain('samograph_funnel_stage{stage="signup"} 7');
  });

  test("renders without a funnel provider too", async () => {
    const r = new MetricsRegistry();
    r.incTranscriptLines("eu-central");
    const handler = metricsHttpHandler(r);
    const res = handler(new Request("http://x/metrics"));
    const body = await res.text();
    expect(body).toContain('transcript_lines_total{region="eu-central"} 1');
  });

  test("non-/metrics paths 404", () => {
    const handler = metricsHttpHandler(new MetricsRegistry());
    expect(handler(new Request("http://x/other")).status).toBe(404);
  });
});
