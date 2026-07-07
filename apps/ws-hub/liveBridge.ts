/**
 * LIVE-STACK composition — ingest ⇄ ws-hub over ONE in-process Hub (#99, §5.5).
 *
 * In production ingest and ws-hub are separate processes joined by the §5.5
 * per-call pub/sub channel — `pg_notify` of the §98 lightweight signal from
 * ingest, `LISTEN` on ws-hub. Bun's built-in SQL has NO `LISTEN` consumer API
 * and we cannot add a driver dependency (`--frozen-lockfile`), so v1 composes
 * the two in ONE process around a shared {@link Hub}:
 *
 *   POST /webhook → §5.3 front door → composed dispatch (pipeline + lifecycle)
 *     writes the row + publishes the §98 SIGNAL into a per-request buffer,
 *   ── the dedup tx COMMITS ──
 *   → the buffered `{ call_id, seq }` signals are handed to the {@link FanIn},
 *     which re-hydrates each line by seq UNDER RLS and `hub.publish`es it,
 *   → FLUSH-ON-PUBLISH pushes it to every subscribed WS connection live.
 *
 * Delivering AFTER commit (not inside the tx) is the in-process analog of
 * `pg_notify`'s commit-gated delivery: a rolled-back webhook publishes nothing,
 * and the persisted row remains the durable record a reconnect backfills (§5.5).
 * The cross-process `pg_notify` path (`PgListenNotifyPublisher`) ships with the
 * SAME signal shape for the future split; only its LISTEN consumer is deferred.
 */
import type { Server, SQL } from "bun";
import { HEALTH_MARKER } from "../../src/server.ts";
import {
  encodeSignal,
  type TranscriptFrame,
  type TranscriptPublisher,
} from "../../packages/shared/transcript/publisher.ts";
import {
  createWebhookHandler,
  pgLookupCallByBotId,
  pgLookupCallByIngestSecret,
  inMemoryWebhookMetrics,
  type CallIdentity,
  type WebhookMetrics,
  type WebhookSecretProvider,
} from "../ingest/webhook.ts";
import { buildIngestDispatch } from "../ingest/server.ts";
import {
  inMemoryTranscriptMetrics,
  type TranscriptMetrics,
} from "../ingest/transcriptPipeline.ts";
import {
  inMemoryBotWorker,
  inMemoryBotLifecycleMetrics,
  type BotLifecycleMetrics,
  type BotWorkerPort,
} from "../ingest/botLifecycle.ts";
import { Hub } from "./hub.ts";
import { ShareCaps } from "./caps.ts";
import { createFanIn, type FanIn } from "./fanIn.ts";
import type { StreamAuthDeps } from "./stream.ts";
import { startWsHubServer, stopServerBounded, type WsHubServerHandle } from "./server.ts";

/** Collaborators for {@link composeLiveStack}. */
export interface LiveStackDeps {
  /** Privileged connection (RLS-bypassing) shared by ingest writes + fan-in reads. */
  sql: SQL;
  /** Tenancy-gate seams (keyring, lookupSession, lookupCallTenant) for ws-hub + fan-in. */
  authDeps: StreamAuthDeps;
  /** Per-region webhook secret provider (§5.3). */
  secretProvider: WebhookSecretProvider;
  /** Bot-worker act port; defaults to an in-memory spy (disclosure/leave, §5.9). */
  worker?: BotWorkerPort;
  /** Share-scope caps; defaults to spec values. */
  caps?: ShareCaps;
  /** Shared Hub; defaults to a fresh one. */
  hub?: Hub;
  /** `?bot=` → call resolver; defaults to the privileged Postgres lookup. */
  lookupCallByBotId?: (botId: string) => Promise<CallIdentity | null>;
  /** `?t=` → call resolver (ingest_secret_hash); defaults to the privileged Postgres lookup. */
  lookupCallByIngestSecret?: (ingestSecretHash: string) => Promise<CallIdentity | null>;
  wsPort?: number;
  ingestPort?: number;
  hostname?: string;
  recheckIntervalMs?: number;
  /** Monotonic clock for the pickup-latency sample (§6.2 #8). */
  clock?: () => number;
  /** Counters (in-memory defaults). */
  transcriptMetrics?: TranscriptMetrics;
  lifecycleMetrics?: BotLifecycleMetrics;
  webhookMetrics?: WebhookMetrics;
}

export interface LiveStackHandle {
  hub: Hub;
  fanIn: FanIn;
  wsHub: WsHubServerHandle;
  ingest: { server: Server<undefined>; port: number; url: string };
  worker: ReturnType<typeof inMemoryBotWorker>;
  stop(): Promise<void>;
}

/** Stand up the composed ingest + ws-hub live stack on a shared in-process Hub. */
export function composeLiveStack(deps: LiveStackDeps): LiveStackHandle {
  const hub = deps.hub ?? new Hub();
  const caps = deps.caps ?? new ShareCaps();
  const worker = (deps.worker as ReturnType<typeof inMemoryBotWorker>) ?? inMemoryBotWorker();
  const transcriptMetrics = deps.transcriptMetrics ?? inMemoryTranscriptMetrics();
  const lifecycleMetrics = deps.lifecycleMetrics ?? inMemoryBotLifecycleMetrics();
  const webhookMetrics = deps.webhookMetrics ?? inMemoryWebhookMetrics();
  const lookupCallByBotId = deps.lookupCallByBotId ?? pgLookupCallByBotId(deps.sql);
  const lookupCallByIngestSecret =
    deps.lookupCallByIngestSecret ?? pgLookupCallByIngestSecret(deps.sql);

  const fanIn = createFanIn({
    sql: deps.sql,
    hub,
    lookupCallTenant: deps.authDeps.lookupCallTenant,
  });

  // ── ws-hub: serves /calls/:id/stream + /transcript off the shared Hub. ───────
  const wsHub = startWsHubServer({
    sql: deps.sql,
    authDeps: { ...deps.authDeps, caps },
    hub,
    caps,
    port: deps.wsPort,
    hostname: deps.hostname,
    recheckIntervalMs: deps.recheckIntervalMs,
  });

  // ── ingest: webhook front door → capture §98 signals → fan-in AFTER commit. ──
  async function ingestFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      // Byte-exact §4.5 marker + nonce echo: this /health is the watchdog's
      // probe target (through PUBLIC_WEBHOOK_BASE), same as apps/ingest/server.ts.
      return Response.json({
        ok: true,
        nonce: url.searchParams.get("nonce") ?? "",
        marker: HEALTH_MARKER,
      });
    }

    // Per-request buffer so concurrent webhooks never interleave their signals.
    const captured: TranscriptFrame[] = [];
    const capturing: TranscriptPublisher = {
      publish(frame) {
        captured.push(frame);
      },
    };
    const dispatch = buildIngestDispatch({
      publisher: capturing,
      worker,
      transcriptMetrics,
      lifecycleMetrics,
      clock: deps.clock,
    });
    const handler = createWebhookHandler({
      secretProvider: deps.secretProvider,
      lookupCallByBotId,
      lookupCallByIngestSecret,
      sql: deps.sql,
      dispatch,
      metrics: webhookMetrics,
    });

    const res = await handler(req);
    // Deliver to the Hub ONLY after the dedup tx committed (res 200): a rolled-back
    // webhook published nothing. Each signal is re-hydrated by seq under RLS.
    if (res.status === 200) {
      for (const frame of captured) {
        await fanIn.deliver(encodeSignal(frame));
      }
    }
    return res;
  }

  const ingestServer = Bun.serve({
    port: deps.ingestPort ?? 0,
    hostname: deps.hostname,
    fetch: (req) => ingestFetch(req),
  });
  const ingestPort = ingestServer.port ?? deps.ingestPort ?? 0;

  return {
    hub,
    fanIn,
    wsHub,
    worker,
    ingest: {
      server: ingestServer,
      port: ingestPort,
      url: `http://${ingestServer.hostname}:${ingestPort}`,
    },
    async stop() {
      await wsHub.stop();
      await stopServerBounded(ingestServer);
    },
  };
}
