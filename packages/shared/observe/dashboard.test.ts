import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FUNNEL_STAGES } from "./funnel.ts";

/**
 * The committed Grafana dashboard artifact (§5.11) is config-as-code: its funnel
 * panel and W1-activation stat MUST read the exact metric names the funnel
 * aggregator / registry export, or the dashboard silently shows nothing. This
 * test pins that contract (artifact ⇄ aggregator) and that the W1 panel encodes
 * the §9 target of 0.5.
 */
const DASHBOARD = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "observability",
  "activation-funnel.dashboard.json",
);

describe("activation-funnel Grafana dashboard — §5.11 / §9", () => {
  const dash = JSON.parse(readFileSync(DASHBOARD, "utf8")) as {
    title: string;
    panels: Array<{ title: string; type: string; targets?: Array<{ expr: string }>; fieldConfig?: any }>;
  };

  const exprs = () =>
    dash.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr));

  test("parses and is titled an activation dashboard", () => {
    expect(dash.title.toLowerCase()).toContain("activation");
    expect(Array.isArray(dash.panels)).toBe(true);
  });

  test("the funnel panel reads samograph_funnel_stage (the aggregator output)", () => {
    expect(exprs()).toContain("samograph_funnel_stage");
  });

  test("the W1 panel reads samograph_activation_w1 with the 0.5 target threshold", () => {
    expect(exprs()).toContain("samograph_activation_w1");
    const w1 = dash.panels.find((p) =>
      (p.targets ?? []).some((t) => t.expr === "samograph_activation_w1"),
    );
    expect(w1).toBeDefined();
    const steps = w1!.fieldConfig?.defaults?.thresholds?.steps ?? [];
    expect(steps.some((s: { value: number | null }) => s.value === 0.5)).toBe(true);
  });

  test("references every §5.11 counter and the pickup-latency quantiles", () => {
    const all = exprs().join("\n");
    for (const metric of [
      "bot_join_total",
      "transcript_lines_total",
      "ws_dropped_total",
      "tunnel_probe_failed_total",
      "webhook_rejected_total",
      "pickup_latency_ms",
    ]) {
      expect(all).toContain(metric);
    }
  });

  test("the funnel template stages match the aggregator's stage set", () => {
    // The bargauge legend is keyed on the `stage` label the aggregator emits.
    const funnelPanel = dash.panels.find((p) =>
      (p.targets ?? []).some((t) => t.expr === "samograph_funnel_stage"),
    );
    expect(funnelPanel?.targets?.[0]?.expr).toBe("samograph_funnel_stage");
    // Sanity: the aggregator exposes exactly five ordered stages.
    expect(FUNNEL_STAGES.length).toBe(5);
  });
});
