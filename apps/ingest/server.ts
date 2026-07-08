/**
 * ingest `Bun.serve` ENTRYPOINT (SPEC §4.1, §5.2, §5.3, §5.4, §4.5/§4.6; #99).
 *
 * Composes the merged units into one running service:
 *   • the §5.3 webhook authenticity FRONT DOOR (`createWebhookHandler`, #93) →
 *   • a `composeDispatch` of the §5.4 transcript PIPELINE (#95/#78) + the §5.2
 *     bot LIFECYCLE (#79), both writing through the shared dedup tx, →
 *   • a {@link TranscriptPublisher} (the §98 `pg_notify`-signal publisher in
 *     production; an in-process bridge in the composed dev/test stack), and
 *   • the leader-elected multi-call tunnel WATCHDOG scheduler (#81), driven here.
 *
 * `GET /health` keeps the byte-exact `samograph-health` marker so a regional
 * cloudflared named tunnel passes the §4.5 round-trip.
 */
import type { Server, SQL } from "bun";
import { HEALTH_MARKER, type HealthFetch } from "../../src/server.ts";
import { PgListenNotifyPublisher, type TranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";
import { stopServerBounded } from "../../packages/shared/serverLifecycle.ts";
import {
  createWebhookHandler,
  pgLookupCallByBotId,
  pgLookupCallByIngestSecret,
  envWebhookSecretProvider,
  type CallIdentity,
  type Dispatch,
  type WebhookLogger,
  type WebhookMetrics,
  type WebhookSecretProvider,
} from "./webhook.ts";
import { createTranscriptPipeline, type TranscriptMetrics } from "./transcriptPipeline.ts";
import {
  createBotLifecycle,
  composeDispatch,
  type BotLifecycleMetrics,
  type BotWorkerPort,
} from "./botLifecycle.ts";
import {
  startRegionWatchdog,
  type RegionWatchdogHandle,
  type WatchdogMetrics,
} from "./tunnelWatchdog.ts";
import { metricsHttpHandler } from "../../packages/shared/observe/metrics-http.ts";
import type { MetricsRegistry } from "../../packages/shared/observe/registry.ts";
import type { FunnelSnapshot } from "../../packages/shared/observe/funnel.ts";

/** What `buildIngestDispatch` needs to compose the two §93 dispatch subscribers. */
export interface IngestDispatchDeps {
  /** Per-call fan-out seam — both the pipeline (#78) and lifecycle (#79) publish on it. */
  publisher: TranscriptPublisher;
  /** Bot-worker act port (disclosure post / clean leave, §5.9). */
  worker: BotWorkerPort;
  /** `transcript_lines_total{region}` counter (§5.11). */
  transcriptMetrics: TranscriptMetrics;
  /** `pickup_latency_ms` counter (§5.11). */
  lifecycleMetrics: BotLifecycleMetrics;
  /** Monotonic clock for the pickup-latency sample; defaults to the wall clock. */
  clock?: () => number;
}

/**
 * Compose the transcript pipeline (acts on `transcript.data`) and the bot
 * lifecycle (acts on `bot.status_change`) into ONE {@link Dispatch} the webhook
 * front door subscribes to — each acts only on its own event kind (#79/#78).
 */
export function buildIngestDispatch(deps: IngestDispatchDeps): Dispatch {
  const pipeline = createTranscriptPipeline({
    publisher: deps.publisher,
    metrics: deps.transcriptMetrics,
  });
  const lifecycle = createBotLifecycle({
    publisher: deps.publisher,
    worker: deps.worker,
    metrics: deps.lifecycleMetrics,
    clock: deps.clock,
  });
  return composeDispatch(pipeline.dispatch, lifecycle.dispatch);
}

/** Collaborators for the composed ingest request handler. */
export interface IngestAppDeps {
  /** Connection used for the tenant-scoped idempotency write + dispatch (§5.3 step 4). */
  sql: SQL;
  /** The composed dispatch (see {@link buildIngestDispatch}). */
  dispatch: Dispatch;
  /** Per-region webhook secret provider; defaults to the env placeholder (§4.10). */
  secretProvider?: WebhookSecretProvider;
  /** `webhook_rejected_total{reason}` counter (§5.11). */
  metrics: WebhookMetrics;
  logger?: WebhookLogger;
  /** `?bot=` → call resolver; defaults to the privileged Postgres lookup. */
  lookupCallByBotId?: (recallBotId: string) => Promise<CallIdentity | null>;
  /** `?t=` → call resolver (ingest_secret_hash); defaults to the privileged Postgres lookup. */
  lookupCallByIngestSecret?: (ingestSecretHash: string) => Promise<CallIdentity | null>;
  /**
   * Shared §5.11 registry to expose at `GET /metrics` (issue #108). When present,
   * the composition root injected this SAME instance into the webhook / transcript
   * / lifecycle counter ports, so /metrics scrapes the live aggregate. Omitted ⇒
   * /metrics falls through to the front door's 404 (no scrape source).
   */
  registry?: MetricsRegistry;
  /** Activation-funnel snapshot thunk folded into /metrics (§9; the #16 feed plugs in here). */
  funnel?: () => FunnelSnapshot;
}

/**
 * The composed ingest request handler: `GET /health` (the §4.5 marker) + the
 * §5.3 `POST /webhook` front door (everything else → the front door's own 404).
 */
export function createIngestApp(deps: IngestAppDeps): (req: Request) => Promise<Response> {
  const webhook = createWebhookHandler({
    secretProvider: deps.secretProvider ?? envWebhookSecretProvider(),
    lookupCallByBotId: deps.lookupCallByBotId ?? pgLookupCallByBotId(deps.sql),
    lookupCallByIngestSecret:
      deps.lookupCallByIngestSecret ?? pgLookupCallByIngestSecret(deps.sql),
    sql: deps.sql,
    dispatch: deps.dispatch,
    metrics: deps.metrics,
    logger: deps.logger,
  });

  // §5.11 `/metrics` scrape endpoint over the SHARED registry (issue #108).
  const metrics = deps.registry ? metricsHttpHandler(deps.registry, deps.funnel) : undefined;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        nonce: url.searchParams.get("nonce") ?? "",
        marker: HEALTH_MARKER,
      });
    }
    if (metrics && req.method === "GET" && url.pathname === "/metrics") {
      return metrics(req);
    }
    return webhook(req);
  };
}

export interface IngestServerDeps extends IngestAppDeps {
  port?: number;
  hostname?: string;
}

export interface IngestServerHandle {
  server: Server<undefined>;
  port: number;
  url: string;
  stop(): Promise<void>;
}

/** Start the ingest HTTP service over a composed {@link createIngestApp} handler. */
export function startIngestServer(deps: IngestServerDeps): IngestServerHandle {
  const app = createIngestApp(deps);
  const server = Bun.serve({
    port: deps.port ?? 0,
    hostname: deps.hostname,
    fetch: (req) => app(req),
  });
  const port = server.port ?? deps.port ?? 0;
  return {
    server,
    port,
    url: `http://${server.hostname}:${port}`,
    // Bounded for shutdown parity with ws-hub (ingest has no server-initiated
    // ws.close, so this resolves promptly).
    stop: () => stopServerBounded(server),
  };
}

/** Collaborators for the per-region watchdog scheduler driver (§4.5/§4.6). */
export interface WatchdogSchedulerDeps {
  /** Privileged infra connection (bypasses RLS: `regions` + cross-tenant `calls`). */
  sql: SQL;
  /** Unique id of THIS ingest replica (the leader identity persisted in `regions`). */
  replicaId: string;
  /** Per-call fan-out seam for the warning/recovery control lines. */
  publisher: TranscriptPublisher;
  /** `tunnel_probe_failed_total{region}` counter (§5.11). */
  metrics: WatchdogMetrics;
  /** Health probe (defaults to the global `fetch`). */
  fetch?: HealthFetch;
  /** Wall clock (defaults to `() => new Date()`). */
  now?: () => Date;
  /** Restrict to these region ids; default discovers every row in `regions`. */
  regionIds?: string[];
}

/**
 * Discover regions and start one self-scheduling {@link startRegionWatchdog} per
 * region (each elects, and only the leader probes — §4.6). Returns a handle that
 * stops every watchdog. This is the "driving the watchdog scheduler" wiring (#81).
 */
export async function startRegionWatchdogs(
  deps: WatchdogSchedulerDeps,
): Promise<{ handles: RegionWatchdogHandle[]; stop(): void }> {
  const regionIds =
    deps.regionIds ??
    ((await deps.sql`SELECT id FROM regions`) as unknown as Array<{ id: string }>).map((r) => r.id);

  const handles = regionIds.map((regionId) =>
    startRegionWatchdog({
      sql: deps.sql,
      regionId,
      replicaId: deps.replicaId,
      publisher: deps.publisher,
      metrics: deps.metrics,
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
      now: deps.now ?? (() => new Date()),
    }),
  );

  return {
    handles,
    stop() {
      for (const h of handles) h.stop();
    },
  };
}

/** Re-export the production §98 publisher so the entrypoint composes it directly. */
export { PgListenNotifyPublisher };
