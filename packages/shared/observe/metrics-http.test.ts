import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "./registry.ts";
import { metricsHttpHandler } from "./metrics-http.ts";
import { aggregateFunnel, type ActivationEvent } from "./funnel.ts";

/**
 * A `/metrics`-style read endpoint (§5.11) that renders the registry plus the
 * activation-funnel snapshot. Config-as-code; hosted provisioning is out of
 * scope (the Grafana dashboard JSON ships alongside).
 */
describe("metricsHttpHandler — §5.11", () => {
  const funnel = aggregateFunnel([
    { userId: "u1", stage: "signup" },
    { userId: "u2", stage: "signup" },
    { userId: "u2", stage: "auth_completed" },
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
  ]);

  test("GET /metrics returns the Prometheus exposition", async () => {
    const r = new MetricsRegistry();
    r.incBotJoin("in_call");
    const handler = metricsHttpHandler(r, () => funnel);
    const res = handler(new Request("http://x/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain('bot_join_total{result="in_call"} 1');
    expect(body).toContain('samograph_funnel_stage{stage="signup",method="magic_link"} 7');
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

/**
 * The `method`-labelled scrape S5-1 item 7 / issue #222 requires. These are the
 * §9 re-baselining numbers verbatim: the blended W1 FALLS (0.5 → 0.333…) while
 * both per-method series stay readable, which is the whole reason the label
 * exists.
 */
describe("metricsHttpHandler — per-method funnel (S5-1 item 7, #222)", () => {
  test("splits samograph_funnel_stage by method and emits no unlabelled series", async () => {
    const funnel = aggregateFunnel([
      { userId: "m1", stage: "signup", method: "magic_link" },
      { userId: "m1", stage: "call_created", method: "magic_link" },
      { userId: "g1", stage: "signup", method: "google" },
      { userId: "g1", stage: "call_created", method: "google" },
    ]);
    const handler = metricsHttpHandler(new MetricsRegistry(), () => funnel);
    const body = await handler(new Request("http://x/metrics")).text();
    expect(body).toContain('samograph_funnel_stage{stage="auth_completed",method="magic_link"} 1');
    expect(body).toContain('samograph_funnel_stage{stage="auth_completed",method="google"} 1');
    expect(body).not.toContain('samograph_funnel_stage{stage="auth_completed"}');
  });

  test("samograph_activation_w1_by_method is exact, and the blend still reports", async () => {
    const events: ActivationEvent[] = [
      { userId: "m1", stage: "signup", method: "magic_link" },
      { userId: "m1", stage: "streamed_30s", method: "magic_link" },
      { userId: "m2", stage: "signup", method: "magic_link" },
      { userId: "g1", stage: "signup", method: "google" },
      { userId: "g1", stage: "streamed_30s", method: "google" },
      { userId: "g2", stage: "signup", method: "google" },
      { userId: "g3", stage: "signup", method: "google" },
      { userId: "g4", stage: "signup", method: "google" },
    ];
    const handler = metricsHttpHandler(new MetricsRegistry(), () => aggregateFunnel(events));
    const body = await handler(new Request("http://x/metrics")).text();
    expect(body).toContain('samograph_activation_w1_by_method{method="magic_link"} 0.5');
    expect(body).toContain('samograph_activation_w1_by_method{method="google"} 0.25');
    expect(body).toContain("samograph_activation_w1 0.3333333333333333");
  });
});
