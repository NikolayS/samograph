/**
 * `/metrics` read endpoint (SPEC §5.11).
 *
 * A tiny, transport-agnostic request handler that renders the {@link
 * MetricsRegistry} Prometheus exposition, folding in the activation-funnel
 * snapshot (§9) when a provider is supplied. The funnel provider is a thunk so a
 * service can compute the snapshot per scrape (e.g. from the DB) without
 * coupling this module to a data source. Hosted provisioning (Grafana/Datadog)
 * is out of scope; the committed dashboard JSON reads the metric names emitted
 * here.
 */
import type { FunnelSnapshot } from "./funnel.ts";
import type { MetricsRegistry } from "./registry.ts";

/** Prometheus text exposition content-type (version 0.0.4). */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Build a `GET /metrics` handler. Any other path/method 404s. The optional
 * `funnel` thunk supplies the activation-funnel snapshot for the current scrape.
 */
export function metricsHttpHandler(
  registry: MetricsRegistry,
  funnel?: () => FunnelSnapshot,
): (req: Request) => Response {
  return (req: Request): Response => {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/metrics") {
      return new Response("not found", { status: 404 });
    }
    const body = registry.renderPrometheus(funnel?.());
    return new Response(body, {
      status: 200,
      headers: { "content-type": METRICS_CONTENT_TYPE },
    });
  };
}
