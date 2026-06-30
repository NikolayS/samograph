/**
 * ws-hub `Bun.serve` ENTRYPOINT (SPEC §4.1, §5.5, §5.6, §6.2 #3/#4; issue #99).
 *
 * This is the glue the transport-agnostic core (#83 `prepareStream`/`openStream`,
 * #82 `Hub`) was missing: a real HTTP+WS server that
 *   • authorizes + UPGRADES `GET /calls/:id/stream` through the single tenancy
 *     gate (`prepareStream`, one DB lookup, no cache) — DENY → bodyless 403,
 *     over-cap share → 429 `SAMO-RATE-001`; the socket opens only on GRANT;
 *   • on open, drives `openStream` (subscribe → backfill/replay → live) and turns
 *     on FLUSH-ON-PUBLISH so each Hub frame is pushed to the socket immediately
 *     (the notify the #83 review flagged as missing);
 *   • runs the per-connection RECHECK timer so a revoke closes the open socket in
 *     ≤ 1 s (the open-socket half of §6.2 #4);
 *   • serves `GET /calls/:id/transcript?since_seq=N`, the REST gap-resync; and
 *   • `GET /health`.
 *
 * The reserved share cap slot is released on EVERY exit path: an upgrade that
 * fails after `prepareStream` reserved a slot frees it here; a backfill throw
 * frees it in `openStream`; a normal close frees it in `StreamConnection.close`.
 */
import type { Server, ServerWebSocket, SQL } from "bun";
import { Hub } from "./hub.ts";
import { ShareCaps, RATE_LIMIT_ERROR_CODE } from "./caps.ts";
import {
  prepareStream,
  openStream,
  RECHECK_INTERVAL_MS,
  type StreamAuthDeps,
  type StreamSocket,
  type PrepareStreamResult,
  type StreamConnection,
} from "./stream.ts";
import { createTranscriptHandler } from "./transcript-http.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";

/** What an upgraded socket carries until {@link WebSocketHandler.open} wires it. */
interface StreamSocketData {
  prepared: Extract<PrepareStreamResult, { ok: true }>;
  conn?: StreamConnection;
  recheck?: ReturnType<typeof setInterval>;
}

export interface WsHubServerDeps {
  /** Privileged connection able to `SET LOCAL ROLE samograph_app`. */
  sql: SQL;
  /** Tenancy-gate seams (+ optional `caps`/`clockMs`); shared by prepare + recheck. */
  authDeps: StreamAuthDeps;
  /** In-process fan-out hub the ingest fan-in publishes onto. Defaults to a fresh Hub. */
  hub?: Hub;
  /** Share-scope anti-abuse caps (§5.7); also taken from `authDeps.caps`. */
  caps?: ShareCaps;
  /** TCP port (0 ⇒ an ephemeral port, useful in tests). */
  port?: number;
  hostname?: string;
  /** Cold-backfill window; defaults to the stream/transcript default (~200). */
  backfillLimit?: number;
  /** Revoke recheck cadence; defaults to {@link RECHECK_INTERVAL_MS} (≤ 1 s). */
  recheckIntervalMs?: number;
  sessionCookieName?: string;
}

export interface WsHubServerHandle {
  server: Server<StreamSocketData>;
  hub: Hub;
  port: number;
  url: string;
  stop(): Promise<void>;
}

const STREAM_PATH = /^\/calls\/([^/]+)\/stream$/;
const TRANSCRIPT_PATH = /^\/calls\/([^/]+)\/transcript$/;

/** Start the ws-hub HTTP+WS server. Returns the live server + its shared Hub. */
export function startWsHubServer(deps: WsHubServerDeps): WsHubServerHandle {
  const hub = deps.hub ?? new Hub();
  const caps = deps.caps ?? deps.authDeps.caps;
  const authDeps: StreamAuthDeps = { ...deps.authDeps, caps };
  const recheckMs = deps.recheckIntervalMs ?? RECHECK_INTERVAL_MS;
  const cookieName = deps.sessionCookieName ?? SESSION_COOKIE_NAME;

  const transcriptHandler = createTranscriptHandler({
    sql: deps.sql,
    authDeps,
    sessionCookieName: cookieName,
    backfillLimit: deps.backfillLimit,
  });

  const server = Bun.serve<StreamSocketData>({
    port: deps.port ?? 0,
    hostname: deps.hostname,
    // Long silences are normal on a live call; keep the socket up near Bun's max.
    // A client reconnect carries `?since_seq` so an idle close loses nothing —
    // a server-side keepalive ping for arbitrarily long silences is a follow-up.
    idleTimeout: 960,
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok", { status: 200 });
      if (TRANSCRIPT_PATH.test(url.pathname)) return transcriptHandler(req);

      if (STREAM_PATH.test(url.pathname)) {
        const prepared = await prepareStream(deps.sql, req, authDeps);
        if (!prepared.ok) return prepared.response; // bodyless 403 or 429 + Retry-After
        const upgraded = srv.upgrade(req, { data: { prepared } });
        if (upgraded) return undefined; // Bun completes the WS handshake
        // Upgrade refused (not a WS request): free the slot prepareStream reserved.
        if (caps && prepared.capKey) caps.release(prepared.capKey);
        return new Response("expected a websocket upgrade", { status: 426 });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      async open(ws: ServerWebSocket<StreamSocketData>) {
        const socket: StreamSocket = {
          send: (data) => {
            try {
              ws.send(data);
            } catch {
              /* socket gone — close handler will clean up */
            }
          },
          close: (code, reason) => {
            try {
              ws.close(code, reason);
            } catch {
              /* already closed */
            }
          },
        };
        try {
          const conn = await openStream(socket, ws.data.prepared, {
            sql: deps.sql,
            hub,
            authDeps,
            backfillLimit: deps.backfillLimit,
            caps,
            clockMs: authDeps.clockMs,
          });
          ws.data.conn = conn;
          // Per-connection revoke recheck (no cache): closes the socket ≤ 1 s after
          // a revoke (§6.2 #4). The close handler clears this timer.
          const timer = setInterval(() => void conn.recheck(), recheckMs);
          (timer as unknown as { unref?: () => void }).unref?.();
          ws.data.recheck = timer;
        } catch {
          // openStream already closed the connection (freed the slot + unsubscribed).
          try {
            ws.close(1011, "stream open failed");
          } catch {
            /* already closing */
          }
        }
      },

      message(ws: ServerWebSocket<StreamSocketData>, _message) {
        const conn = ws.data.conn;
        if (!conn) return;
        // Account every client→server command against the share command-rate cap
        // (§5.7); over-cap → a SAMO-RATE-001 frame and the command is ignored. v1
        // clients are read-only, so there is nothing else to process.
        const decision = conn.command();
        if (!decision.allowed) {
          try {
            ws.send(
              JSON.stringify({
                type: "error",
                code: RATE_LIMIT_ERROR_CODE,
                message: "Too many commands on this link.",
                retryable: true,
                retry_after_ms: decision.retryAfterMs,
              }),
            );
          } catch {
            /* socket gone */
          }
        }
      },

      close(ws: ServerWebSocket<StreamSocketData>) {
        if (ws.data.recheck) clearInterval(ws.data.recheck);
        ws.data.conn?.close();
      },
    },
  });

  const port = server.port ?? deps.port ?? 0;
  return {
    server,
    hub,
    port,
    url: `http://${server.hostname}:${port}`,
    stop: () => stopServerBounded(server),
  };
}

/**
 * Stop a `Bun.serve` server with a bounded wait. Bun 1.3.14's `server.stop()`
 * does not resolve once the server has INITIATED a `ws.close()` (our revoke-
 * recheck path) — the listener is closing but the promise hangs. Every caller
 * here stops to exit (tests / dev shutdown), so cap the wait to keep teardown
 * deterministic. Exported so the ingest entrypoint reuses the same discipline.
 */
export async function stopServerBounded(
  server: { stop(closeActive?: boolean): Promise<void> },
  ms = 2000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    server.stop(true).then(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}
