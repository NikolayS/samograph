/**
 * `GET /calls/:id/stream` WS upgrade core — authorize, backfill, then live
 * (SPEC §5.5, §5.6, §6.2 #3/#4). Transport-agnostic: it drives an abstract
 * {@link StreamSocket} so it can be unit-tested with a fake sink and wired onto
 * Bun's `server.upgrade` in production without changing this logic.
 *
 * The lifecycle of one stream connection:
 *
 *   1. {@link prepareStream} runs the SINGLE tenancy gate (`authorizeCall`,
 *      §5.6) exactly ONCE per upgrade — session cookie → `read`, share token →
 *      `share`. There is NO in-process token cache (§5.5): every upgrade is one
 *      DB lookup, so a revoke lands on the very next upgrade (the ≤ 1 s SLO,
 *      §6.2 #4). DENY → a bodyless 403; the socket is NEVER opened.
 *   2. {@link openStream} subscribes to the per-`call_id` Hub channel (#91)
 *      BEFORE reading the DB, so no live frame published during the backfill read
 *      is lost, then sends the backfill (last ~200 finalized lines) — or, when
 *      the upgrade carried `?since_seq=N`, the exact replay tail `seq > N` — and
 *      finally flushes live frames, DEDUPING any frame at/below the last line it
 *      already sent. Result: backfill-then-live with no gap and no duplicate of
 *      the boundary `seq`.
 *   3. The hub's `{type:"gap"}` overflow control frame is forwarded verbatim so
 *      the client can REST-backfill the dropped range — finals are never silently
 *      dropped (§5.5).
 *   4. {@link StreamConnection.recheck} re-runs the gate (again, no cache) and
 *      CLOSES the socket if the grant is gone — the revoke-closes-an-open-socket
 *      half of the ≤ 1 s SLO, driven by a {@link RECHECK_INTERVAL_MS} timer in
 *      production. (Numeric share caps / rate limits are the share-scope issue.)
 */
import type { SQL } from "bun";
import { setTenant } from "../../packages/shared/db/client.ts";
import { authorizeCall, type AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import { Hub, type GapFrame, type OutboundFrame } from "./hub.ts";
import { parseSinceSeq, readCallCredentials, type CallCredentials } from "./request.ts";
import {
  backfillRecent,
  replayTranscripts,
  DEFAULT_BACKFILL_LIMIT,
  type TranscriptLine,
} from "./transcript.ts";

/** How often an open socket is re-authorized so a revoke closes it ≤ 1 s (§5.5). */
export const RECHECK_INTERVAL_MS = 1000;

/** The scope a connection is tagged with for the downstream caps issue (§5.6). */
export type StreamScope = "read" | "share";

/** The minimal socket sink the connection drives (Bun's ServerWebSocket fits). */
export interface StreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** The credentials lifted off an upgrade request — re-checked on every recheck. */
export type StreamCredentials = CallCredentials;

/** A parsed `/calls/:id/stream` upgrade request (before authorization). */
export interface ParsedStreamRequest {
  callId: string;
  /** `?since_seq=N` for replay, or `null` for a fresh backfill subscription. */
  sinceSeq: number | null;
  credentials: StreamCredentials;
}

/** The gate seams + cookie name the stream layer needs to authorize an upgrade. */
export interface StreamAuthDeps extends AuthorizeDeps {
  /** Session cookie name; defaults to the app-api {@link SESSION_COOKIE_NAME}. */
  sessionCookieName?: string;
}

/** Outcome of {@link prepareStream}: open the socket, or render a bodyless 403. */
export type PrepareStreamResult =
  | {
      ok: true;
      callId: string;
      tenantId: string;
      scope: StreamScope;
      scopes: string[];
      sinceSeq: number | null;
      credentials: StreamCredentials;
    }
  | { ok: false; response: Response };

/** The single bodyless 403 a denied upgrade renders (§5.6 / `SAMO-AUTHZ-001`). */
function deniedResponse(): Response {
  return new Response(null, { status: 403 });
}

/**
 * Parse a `GET /calls/:id/stream` upgrade request into its call id, optional
 * `?since_seq`, and credentials — or `null` when the path is not a stream route.
 */
export function parseStreamRequest(
  req: Request,
  cookieName: string = SESSION_COOKIE_NAME,
): ParsedStreamRequest | null {
  const url = new URL(req.url);
  const match = /^\/calls\/([^/]+)\/stream$/.exec(url.pathname);
  if (!match) return null;
  return {
    callId: decodeURIComponent(match[1]),
    sinceSeq: parseSinceSeq(url),
    credentials: readCallCredentials(req, url, cookieName),
  };
}

/**
 * Run the tenancy gate for one upgrade — ONE DB lookup, no cache (§5.5). Mirrors
 * the `/calls` REST routes: a tx as the non-super `samograph_app` role so RLS
 * (not app logic) enforces tenant isolation. Reused by {@link prepareStream} and
 * by every {@link StreamConnection.recheck}, so a revoke is observed each time.
 */
async function authorizeUpgrade(
  sql: SQL,
  callId: string,
  credentials: StreamCredentials,
  deps: AuthorizeDeps,
) {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE samograph_app");
    return authorizeCall(
      tx as unknown as SQL,
      { callId, sessionCookie: credentials.sessionCookie, shareToken: credentials.shareToken },
      deps,
    );
  });
}

/** Map the granted scopes to the connection tag the caps issue keys off (§5.6). */
function tagScope(scopes: string[]): StreamScope {
  return scopes.includes("read") ? "read" : "share";
}

/**
 * Authorize an upgrade and decide whether to open the socket. On GRANT returns
 * the call/tenant/scope + the parsed `since_seq` and credentials; on DENY (or a
 * non-stream path) returns a bodyless 403 to render — the socket never opens.
 */
export async function prepareStream(
  sql: SQL,
  req: Request,
  deps: StreamAuthDeps,
): Promise<PrepareStreamResult> {
  const parsed = parseStreamRequest(req, deps.sessionCookieName ?? SESSION_COOKIE_NAME);
  if (!parsed) return { ok: false, response: deniedResponse() };

  const authz = await authorizeUpgrade(sql, parsed.callId, parsed.credentials, deps);
  if (!authz.authorized) return { ok: false, response: deniedResponse() };

  return {
    ok: true,
    callId: authz.callId,
    tenantId: authz.tenantId,
    scope: tagScope(authz.scopes),
    scopes: authz.scopes,
    sinceSeq: parsed.sinceSeq,
    credentials: parsed.credentials,
  };
}

/** A frame is the hub's gap control frame (no `seq`) rather than a data line. */
function isGap(frame: OutboundFrame): frame is GapFrame {
  return (frame as GapFrame).type === "gap";
}

/** Construction inputs for a {@link StreamConnection} (see {@link openStream}). */
export interface StreamConnectionInit {
  socket: StreamSocket;
  hub: Hub;
  callId: string;
  scope: StreamScope;
  /** The Hub subscriber (already subscribed BEFORE the backfill read). */
  subscriber: ReturnType<Hub["subscribe"]>;
  /** Highest `seq` already delivered (the `since_seq` boundary, or 0). */
  initialSeq: number;
  /** Re-authorize seam: `false` ⇒ the grant is gone ⇒ close the socket. */
  reauthorize: () => Promise<boolean>;
}

/**
 * One live WS stream connection: sends backfill/replay, then live frames with a
 * boundary dedupe, forwards gap control frames, and re-authorizes on demand.
 */
export class StreamConnection {
  readonly callId: string;
  readonly scope: StreamScope;
  private readonly socket: StreamSocket;
  private readonly hub: Hub;
  private readonly subscriber: ReturnType<Hub["subscribe"]>;
  private readonly reauthorize: () => Promise<boolean>;
  /** Highest `seq` sent so far — the dedupe/no-gap boundary. */
  private lastSeq: number;
  private closed = false;

  constructor(init: StreamConnectionInit) {
    this.callId = init.callId;
    this.scope = init.scope;
    this.socket = init.socket;
    this.hub = init.hub;
    this.subscriber = init.subscriber;
    this.reauthorize = init.reauthorize;
    this.lastSeq = init.initialSeq;
  }

  /** Highest `seq` delivered to the client so far (observability / tests). */
  highWaterSeq(): number {
    return this.lastSeq;
  }

  /** Whether this connection has been closed. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Send the backfill/replay lines in order, advancing the dedupe boundary. */
  sendBackfill(lines: TranscriptLine[]): void {
    if (this.closed) return;
    for (const line of lines) {
      this.socket.send(
        JSON.stringify({ type: "line", seq: line.seq, ts: line.ts, speaker: line.speaker, text: line.text }),
      );
      if (line.seq > this.lastSeq) this.lastSeq = line.seq;
    }
  }

  /**
   * Drain the subscriber's queue to the socket: gap control frames are forwarded
   * verbatim (the client REST-backfills the dropped range); data frames are sent
   * only when `seq > lastSeq`, so a frame already covered by the backfill/replay
   * — including the exact boundary `seq` — is never duplicated.
   */
  flush(): void {
    if (this.closed) return;
    for (const frame of this.subscriber.drain()) {
      if (isGap(frame)) {
        this.socket.send(JSON.stringify(frame));
        continue;
      }
      if (frame.seq > this.lastSeq) {
        this.socket.send(JSON.stringify(frame));
        this.lastSeq = frame.seq;
      }
    }
  }

  /**
   * Re-authorize (one DB lookup, no cache) and CLOSE the socket if the grant is
   * gone — the open-socket half of the ≤ 1 s revoke SLO (§5.5). Returns whether
   * the connection is still authorized after the check.
   */
  async recheck(): Promise<boolean> {
    if (this.closed) return false;
    let stillAuthorized = false;
    try {
      stillAuthorized = await this.reauthorize();
    } catch {
      stillAuthorized = false; // fail closed (§5.6)
    }
    if (!stillAuthorized) this.close(1008, "authorization revoked");
    return stillAuthorized;
  }

  /** Unsubscribe from the hub and close the socket. Idempotent. */
  close(code = 1000, reason = "stream closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.unsubscribe(this.subscriber);
    this.socket.close(code, reason);
  }
}

/** Injected collaborators for {@link openStream}. */
export interface OpenStreamDeps {
  /** Privileged connection able to `SET LOCAL ROLE samograph_app`. */
  sql: SQL;
  hub: Hub;
  /** Gate seams, reused for the open-socket re-authorization (no cache). */
  authDeps: AuthorizeDeps;
  /** Backfill window; defaults to {@link DEFAULT_BACKFILL_LIMIT}. */
  backfillLimit?: number;
}

/**
 * Open an authorized stream onto `socket`: subscribe to the call's Hub channel
 * FIRST (so live frames during the read are not lost), read the backfill (last
 * ~200 lines) or the `since_seq` replay tail, send it, then flush live with the
 * boundary dedupe. Returns the live {@link StreamConnection}.
 */
export async function openStream(
  socket: StreamSocket,
  prepared: Extract<PrepareStreamResult, { ok: true }>,
  deps: OpenStreamDeps,
): Promise<StreamConnection> {
  const { sql, hub, authDeps } = deps;
  const limit = deps.backfillLimit ?? DEFAULT_BACKFILL_LIMIT;

  // Subscribe BEFORE the DB read: any frame published during the read is then
  // queued on the subscriber and reconciled by the boundary dedupe below.
  const subscriber = hub.subscribe(prepared.callId);

  const reauthorize = async () =>
    (await authorizeUpgrade(sql, prepared.callId, prepared.credentials, authDeps)).authorized;

  const connection = new StreamConnection({
    socket,
    hub,
    callId: prepared.callId,
    scope: prepared.scope,
    subscriber,
    initialSeq: prepared.sinceSeq ?? 0,
    reauthorize,
  });

  // Read backfill/replay under the call's tenant (RLS-scoped, §5.10).
  const lines = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE samograph_app");
    await setTenant(tx as unknown as SQL, prepared.tenantId);
    return prepared.sinceSeq !== null
      ? replayTranscripts(tx as unknown as SQL, prepared.callId, prepared.sinceSeq)
      : backfillRecent(tx as unknown as SQL, prepared.callId, limit);
  });

  connection.sendBackfill(lines);
  connection.flush();
  return connection;
}
