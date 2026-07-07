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
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { setTenant } from "../../packages/shared/db/client.ts";
import { authorizeCall, type AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import { Hub, type ControlFrame, type DataFrame, type GapFrame, type OutboundFrame } from "./hub.ts";
import { parseSinceSeq, readCallCredentials, type CallCredentials } from "./request.ts";
import { ShareCaps, shareCapKey, rateLimitedResponse, type CapDecision } from "./caps.ts";
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
  /**
   * Share-scope anti-abuse caps (§5.7, §6.2 #10). When present, a `share`-tagged
   * upgrade is admitted through {@link ShareCaps.tryEstablish}; `read` upgrades
   * are never consulted. Omitted ⇒ no caps enforced (the pre-caps behaviour).
   */
  caps?: ShareCaps;
  /** Epoch-ms clock the caps read; defaults to the wall clock. */
  clockMs?: () => number;
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
      /**
       * Per-token cap key (set only for an admitted `share` upgrade when caps are
       * configured). {@link openStream} hands it to the {@link StreamConnection}
       * so the reserved concurrent slot is released exactly once on close.
       */
      capKey?: string;
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

  const scope = tagScope(authz.scopes);

  // Share-scope anti-abuse caps (§5.7, §6.2 #10): a `share` upgrade must clear
  // the per-token establishment-rate AND concurrent-connection caps BEFORE the
  // socket opens; over-cap → 429 + Retry-After (`SAMO-RATE-001`). `read` upgrades
  // are deliberately NOT consulted (they carry their own session-scoped limits,
  // §5.7). The reserved slot is released on close via the returned `capKey`.
  let capKey: string | undefined;
  if (scope === "share" && deps.caps && parsed.credentials.shareToken) {
    capKey = shareCapKey(parsed.credentials.shareToken);
    const now = (deps.clockMs ?? Date.now)();
    const decision = deps.caps.tryEstablish(capKey, now);
    if (!decision.allowed) {
      return { ok: false, response: rateLimitedResponse(decision.retryAfterMs) };
    }
  }

  return {
    ok: true,
    callId: authz.callId,
    tenantId: authz.tenantId,
    scope,
    scopes: authz.scopes,
    sinceSeq: parsed.sinceSeq,
    credentials: parsed.credentials,
    capKey,
  };
}

/** A frame is the hub's gap control frame (no `seq`) rather than a data line. */
function isGap(frame: OutboundFrame): frame is GapFrame {
  return (frame as GapFrame).type === "gap";
}

/** A live `{type:"status"}` control frame (#106) carrying a string status. */
function isStatusControl(frame: OutboundFrame): frame is ControlFrame & { status: string } {
  return (
    (frame as { type?: unknown }).type === "status" &&
    typeof (frame as { status?: unknown }).status === "string"
  );
}

/** A data line frame — the only outbound kind carrying a numeric `seq`. */
function isData(frame: OutboundFrame): frame is DataFrame {
  return typeof (frame as { seq?: unknown }).seq === "number";
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
  /** Share caps (§5.7): per-connection command rate + the concurrent slot to free on close. */
  caps?: ShareCaps;
  /** The per-token cap key reserved at establish time (released on close). */
  capKey?: string;
  /** Epoch-ms clock the command-rate cap reads; defaults to the wall clock. */
  clockMs?: () => number;
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
  private readonly caps?: ShareCaps;
  private readonly capKey?: string;
  private readonly clockMs: () => number;
  /** Per-connection identity the command-rate cap is keyed on (§5.7). */
  private readonly connId = randomUUID();
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
    this.caps = init.caps;
    this.capKey = init.capKey;
    this.clockMs = init.clockMs ?? Date.now;
    this.lastSeq = init.initialSeq;
  }

  /**
   * Account a client→server command against the per-connection share command-rate
   * cap (20 / 60 s, §5.7). `read` connections — and connections with no caps — are
   * never share-capped (`read` carries its own session-scoped limit). The caller
   * sends a `SAMO-RATE-001` error frame and ignores the command when `!allowed`.
   */
  command(): CapDecision {
    if (this.scope !== "share" || !this.caps) return { allowed: true, retryAfterMs: 0 };
    return this.caps.tryCommand(this.connId, this.clockMs());
  }

  /** Highest `seq` delivered to the client so far (observability / tests). */
  highWaterSeq(): number {
    return this.lastSeq;
  }

  /** The per-connection id the share command-rate cap is keyed on (close pruning). */
  connectionId(): string {
    return this.connId;
  }

  /**
   * Turn on FLUSH-ON-PUBLISH (#99): wire the Hub subscriber so each published
   * frame is drained to the socket immediately. Call this ONCE, AFTER the initial
   * backfill/replay has been sent (so a frame queued during the read is delivered
   * in order by that first {@link flush}, not interleaved ahead of the backfill).
   */
  enableAutoFlush(): void {
    if (this.closed) return;
    this.subscriber.onEnqueue = () => this.flush();
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
        JSON.stringify({ type: "line", seq: line.seq, ts: line.ts, speaker: line.speaker, text: line.text, final: true }),
      );
      if (line.seq > this.lastSeq) this.lastSeq = line.seq;
    }
  }

  /**
   * Drain the subscriber's queue to the socket: gap control frames are forwarded
   * verbatim (the client REST-backfills the dropped range); a `{type:"status"}`
   * control frame (#106) is serialized as the client's `{type:"status", status}`
   * event (no seq — it never touches the dedupe boundary); data frames are sent
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
      if (isStatusControl(frame)) {
        // Exactly the reducer's wire shape (§5.2/§5.5) — no internal fields.
        this.socket.send(JSON.stringify({ type: "status", status: frame.status }));
        continue;
      }
      // Remaining control lanes (warning/degraded) are a tracked follow-up (#106);
      // a malformed control frame is dropped rather than crash the stream.
      if (!isData(frame)) continue;
      if (frame.seq > this.lastSeq) {
        // The hub only carries finalized lines — mark `final` so the client
        // appends it instead of holding it as a single replaceable partial.
        this.socket.send(
          JSON.stringify({ type: "line", seq: frame.seq, ts: frame.ts, speaker: frame.speaker, text: frame.text, final: true }),
        );
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

  /** Unsubscribe from the hub, free the share concurrent slot, and close. Idempotent. */
  close(code = 1000, reason = "stream closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.subscriber.onEnqueue = null; // stop flush-on-publish before unsubscribe
    // Free the per-token concurrent slot reserved at establish time (§5.7) — once,
    // because `closed` guards re-entry. A `read` connection has no `capKey`.
    if (this.caps) {
      if (this.capKey) this.caps.release(this.capKey);
      // Prune the per-connection command-rate window so it is not leaked (#102).
      this.caps.forgetConnection(this.connId);
    }
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
  /** Share caps (§5.7): handed to the connection for command-rate + slot release. */
  caps?: ShareCaps;
  /** Epoch-ms clock the command-rate cap reads; defaults to the wall clock. */
  clockMs?: () => number;
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
    caps: deps.caps,
    capKey: prepared.capKey,
    clockMs: deps.clockMs,
  });

  // Read backfill/replay under the call's tenant (RLS-scoped, §5.10). A throw here
  // (DB outage, bad cursor) must NOT leak the reserved share cap slot or the Hub
  // subscription that were taken before this point (#102 review): close the
  // connection (releases the slot exactly once + unsubscribes) and rethrow.
  try {
    const lines = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx as unknown as SQL, prepared.tenantId);
      return prepared.sinceSeq !== null
        ? replayTranscripts(tx as unknown as SQL, prepared.callId, prepared.sinceSeq)
        : backfillRecent(tx as unknown as SQL, prepared.callId, limit);
    });

    connection.sendBackfill(lines);
    connection.flush();
    // Switch to FLUSH-ON-PUBLISH for everything after the backfill (#99). Enabling
    // it here — after the synchronous backfill flush, before yielding — means no
    // live frame can slip in unflushed: nothing else runs between flush() and this.
    connection.enableAutoFlush();
  } catch (err) {
    connection.close(1011, "backfill failed");
    throw err;
  }
  return connection;
}
