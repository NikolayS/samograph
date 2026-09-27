/**
 * Tunnel-free remote watch over WebSocket (#307, prototype 3/3).
 *
 * The laptop opens ONE outbound socket to the hosted ws-hub
 * (`GET /calls/:id/stream?since_seq=N`) and receives transcript lines as they
 * are pushed. No public address, no ngrok/cloudflared.
 *
 * Delivery contract: the client always asks for "everything after cursor N"
 * (`since_seq`), never a fixed tail. It keeps `last` = the highest seq it has
 * emitted and
 *   • drops any line with `seq <= last` (boundary replays, duplicates);
 *   • on a `{type:"gap"}` frame OR a seq hole (`seq > last + 1`), fetches the
 *     missing range from `GET /calls/:id/transcript?since_seq=last` first;
 *   • on any disconnect, reconnects with exponential backoff + jitter, resuming
 *     from `since_seq=last`;
 *   • on 401/403, stops with a clear message (no retry loop).
 *
 * Auth (stage 1): a per-call share token, sent ONLY as `Authorization: Bearer`
 * on the upgrade and on REST fills — never in a URL, never logged.
 */
import { renderTranscriptLine } from "../packages/shared/transcript/index.ts";

export interface RemoteLine {
  seq: number;
  ts: string;
  speaker: string | null;
  text: string;
  kind?: "chat" | "speech";
}

export type RemoteWatchEvent =
  | { type: "open"; sinceSeq: number; drop: () => void }
  | { type: "ping" }
  | { type: "reconnect"; attempt: number; delayMs: number }
  | { type: "gap-fill"; fromSeq: number; count: number };

export type RemoteWatchResult =
  | { reason: "aborted" }
  | { reason: "unauthorized"; status: number }
  | { reason: "ended"; status: string };

export interface RemoteWatchOptions {
  /** ws-hub base URL (http(s)://host[:port]); the scheme is mapped to ws(s). */
  site: string;
  callId: string;
  /** Per-call share token. Header-only; never put in a URL or a log line. */
  token: string;
  /** Resume cursor: deliver lines with seq > sinceSeq (default 0 = all). */
  sinceSeq?: number;
  /** Called once per line, in seq order, with the canonical `[ts] Speaker: text`. */
  onLine: (rendered: string, line: RemoteLine) => void | Promise<void>;
  log?: (msg: string) => void;
  onEvent?: (e: RemoteWatchEvent) => void;
  signal?: AbortSignal;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  /**
   * No frame and no ping for this long ⇒ treat the socket as dead and reconnect.
   * Also the upgrade (handshake) timeout.
   */
  staleMs?: number;
}

/** Call statuses after which no more lines can arrive (0001/0002 migrations). */
const TERMINAL = new Set(["ENDED", "COULD_NOT_JOIN", "COULD_NOT_RECORD", "BOT_REMOVED"]);

function trimBase(site: string): string {
  return site.replace(/\/+$/, "");
}

/** `ws(s)://host/calls/:id/stream?since_seq=N` — the cursor is the ONLY query param. */
export function streamUrl(site: string, callId: string, sinceSeq: number): string {
  const base = trimBase(site).replace(/^http/i, "ws");
  return `${base}/calls/${encodeURIComponent(callId)}/stream?since_seq=${sinceSeq}`;
}

/** Exponential backoff with "equal jitter": delay ∈ [d/2, d], d = min(max, base·2^attempt). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const d = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(d / 2 + (d / 2) * random());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

interface SocketOutcome {
  opened: boolean;
  /** The server sent at least one frame or ping: only then is backoff reset. */
  healthy: boolean;
  ended?: string;
}

/** Cap on a server Retry-After (the longest share cap window is one hour). */
const MAX_RETRY_AFTER_MS = 3_600_000;

export async function remoteWatch(o: RemoteWatchOptions): Promise<RemoteWatchResult> {
  const log = o.log ?? (() => {});
  const emit = o.onEvent ?? (() => {});
  const baseMs = o.backoffBaseMs ?? 500;
  const maxMs = o.backoffMaxMs ?? 30_000;
  const random = o.random ?? Math.random;
  const staleMs = o.staleMs ?? 75_000;
  const httpBase = trimBase(o.site).replace(/^ws/i, "http");
  const callPath = `/calls/${encodeURIComponent(o.callId)}`;
  const authHeaders = { authorization: `Bearer ${o.token}` };
  /** Every REST request (fill, status probe) is bounded, so a hung upstream cannot stall the watch. */
  const reqTimeoutMs = Math.min(staleMs, 15_000);
  const reqSignal = () =>
    o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(reqTimeoutMs)]) : AbortSignal.timeout(reqTimeoutMs);

  let last = o.sinceSeq ?? 0;
  /** A hole we already resynced for once; if it persists we accept it (no loop). */
  let resyncedHole = -1;

  async function emitLine(l: RemoteLine): Promise<void> {
    if (l.seq <= last) return;
    last = l.seq;
    await o.onLine(renderTranscriptLine(l), l);
  }

  /** REST gap-fill: everything after `last`. Returns false on any failure. */
  async function fill(): Promise<boolean> {
    const from = last;
    try {
      const res = await fetch(`${httpBase}${callPath}/transcript?since_seq=${from}`, {
        headers: authHeaders,
        signal: reqSignal(),
      });
      if (!res.ok) {
        log(`gap fill failed (HTTP ${res.status}); resyncing via reconnect`);
        return false;
      }
      const body = (await res.json()) as { lines?: RemoteLine[] };
      const lines = [...(body.lines ?? [])].sort((a, b) => a.seq - b.seq);
      for (const l of lines) await emitLine(l);
      emit({ type: "gap-fill", fromSeq: from, count: lines.length });
      return true;
    } catch {
      log("gap fill failed (network); resyncing via reconnect");
      return false;
    }
  }

  /** Handle one data line. Returns false when the socket must be resynced. */
  async function handleLine(l: RemoteLine): Promise<boolean> {
    if (l.seq <= last) return true;
    if (l.seq > last + 1) {
      if (!(await fill())) return false;
      if (l.seq > last + 1) {
        if (resyncedHole !== l.seq) {
          resyncedHole = l.seq;
          return false; // one reconnect-replay attempt before accepting the hole
        }
        log(`seq ${last + 1}..${l.seq - 1} missing on the server; continuing`);
      }
    }
    await emitLine(l);
    return true;
  }

  /** Probe the upgrade's HTTP status (Bun's WS client hides it) — header auth only. */
  async function probeStatus(): Promise<{ status: number; retryAfterMs: number }> {
    try {
      const res = await fetch(`${httpBase}${callPath}/stream?since_seq=${last}`, {
        headers: authHeaders,
        signal: reqSignal(),
      });
      await res.body?.cancel();
      const ra = Number(res.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_RETRY_AFTER_MS) : 0;
      return { status: res.status, retryAfterMs };
    } catch {
      return { status: 0, retryAfterMs: 0 };
    }
  }

  function connectOnce(): Promise<SocketOutcome> {
    return new Promise((resolve) => {
      const url = streamUrl(o.site, o.callId, last);
      // Bun's WebSocket client sends custom headers on the upgrade request.
      const ws = new WebSocket(url, { headers: authHeaders } as unknown as string[]);
      let opened = false;
      let healthy = false;
      let settled = false;
      let ended: string | undefined;
      let chain: Promise<void> = Promise.resolve();
      let stale: ReturnType<typeof setTimeout> | undefined;

      const settle = () => {
        if (settled) return;
        settled = true;
        if (stale) clearTimeout(stale);
        o.signal?.removeEventListener("abort", onAbort);
        void chain.then(() => resolve({ opened, healthy, ended }));
      };
      // Bun never fires `close` for a socket that is still CONNECTING, so a
      // stalled upgrade is settled here directly rather than via onclose.
      const giveUp = (code: number, reason: string) => {
        ws.close(code, reason);
        if (!opened) settle();
      };
      const armStale = () => {
        if (stale) clearTimeout(stale);
        stale = setTimeout(() => {
          log(
            opened
              ? `no frames or pings for ${Math.round(staleMs / 1000)}s; reconnecting`
              : `no upgrade response in ${Math.round(staleMs / 1000)}s; reconnecting`,
          );
          giveUp(4000, "stale");
        }, staleMs);
      };
      const onAbort = () => giveUp(1000, "client exit");
      o.signal?.addEventListener("abort", onAbort, { once: true });
      armStale(); // handshake timeout

      ws.onopen = () => {
        opened = true;
        armStale();
        log(`connected ${url}`);
        emit({ type: "open", sinceSeq: last, drop: () => ws.close(4001, "dropped") });
      };
      ws.addEventListener("ping", () => {
        healthy = true;
        armStale();
        emit({ type: "ping" });
      });
      ws.onmessage = (e: MessageEvent) => {
        healthy = true;
        armStale();
        let f: Record<string, unknown>;
        try {
          f = JSON.parse(String(e.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        chain = chain.then(async () => {
          if (o.signal?.aborted || ended) return;
          let ok = true;
          if (f.type === "line" && typeof f.seq === "number") {
            ok = await handleLine(f as unknown as RemoteLine);
          } else if (f.type === "gap") {
            ok = await fill();
          } else if (f.type === "status" && typeof f.status === "string" && TERMINAL.has(f.status)) {
            ended = f.status;
            ws.close(1000, "call ended");
          }
          if (!ok) ws.close(4002, "resync");
        });
      };
      ws.onerror = () => {
        /* a close event always follows */
      };
      ws.onclose = settle;
    });
  }

  let attempt = 0;
  while (!o.signal?.aborted) {
    const out = await connectOnce();
    if (o.signal?.aborted) break;
    if (out.ended) {
      // Lines committed just before the status change may still be unsent.
      await fill();
      log(`call ${o.callId} ended (${out.ended})`);
      return { reason: "ended", status: out.ended };
    }
    let floorMs = 0;
    if (out.healthy) {
      attempt = 0; // a socket that opened and then closed at once keeps backing off
    }
    if (!out.opened) {
      const { status, retryAfterMs } = await probeStatus();
      if (status === 401 || status === 403) {
        log(`not authorized for call ${o.callId} (HTTP ${status}): the share token is invalid, expired, revoked, or for another call`);
        return { reason: "unauthorized", status };
      }
      floorMs = retryAfterMs;
    }
    const delayMs = Math.max(floorMs, backoffDelay(attempt, baseMs, maxMs, random));
    attempt += 1;
    emit({ type: "reconnect", attempt, delayMs });
    log(`disconnected; reconnecting in ${delayMs}ms from since_seq=${last}`);
    await sleep(delayMs, o.signal);
  }
  return { reason: "aborted" };
}
