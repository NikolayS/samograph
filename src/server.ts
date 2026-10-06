import { appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizeTranscriptEvent } from "./transcript.ts";
import { TranscriptLog, type TranscriptLogEntry } from "./transcriptLog.ts";
import {
  decodeVideoSeparatePng,
  frameSourceAliases,
  normalizeFrameSource,
  type DecodedVideoFrame,
  type VideoFrameMetadata,
} from "./frameStore.ts";
import {
  activityFromTranscriptLine,
  activityKindForState,
  appendPresenceActivity,
  defaultPresenceMessage,
  labelForPresenceState,
  newPresenceSnapshot,
  normalizePresenceState,
  presencePageHtml,
  sanitizePresenceMessage,
  sanitizePresenceText,
  withChime,
  type PresenceSnapshot,
} from "./presence.ts";

export const WEBHOOK_MAX_BYTES = 1024 * 1024;

/**
 * Marker echoed by GET /health. The tunnel round-trip checks (join preflight
 * and mid-call watchdog) require it so a tunnel interstitial or error page
 * can never pass as a healthy response.
 */
export const HEALTH_MARKER = "samograph-health";

export type HealthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TunnelProbeResult {
  ok: boolean;
  /** ngrok error code (e.g. ERR_NGROK_727) when the tunnel reported one. */
  ngrokErrorCode: string | null;
}

/**
 * Single tunnel round-trip probe: fetch `${publicBaseUrl}/health?nonce=...`
 * (through the public tunnel, back to this server) and verify the response
 * echoes our nonce with the health marker. ngrok error pages are recognized
 * via the ngrok-error-code header (or the ERR_NGROK_* string in the body).
 */
export async function probeTunnelHealth(
  publicBaseUrl: string,
  fetchFn: HealthFetch = fetch,
  nonceFn: () => string = randomUUID,
): Promise<TunnelProbeResult> {
  const nonce = nonceFn();
  try {
    const response = await fetchFn(
      `${publicBaseUrl}/health?nonce=${encodeURIComponent(nonce)}`,
      { cache: "no-store", signal: AbortSignal.timeout(5000) },
    );
    const headerCode = response.headers.get("ngrok-error-code");
    if (headerCode) {
      return { ok: false, ngrokErrorCode: headerCode.trim() };
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { nonce?: unknown; marker?: unknown }
        | null;
      if (body !== null && body.nonce === nonce && body.marker === HEALTH_MARKER) {
        return { ok: true, ngrokErrorCode: null };
      }
      // 200 but not our payload: interstitial or another server entirely.
      return { ok: false, ngrokErrorCode: null };
    }
    const text = await response.text().catch(() => "");
    const bodyCode = text.match(/ERR_NGROK_\d+/);
    return { ok: false, ngrokErrorCode: bodyCode ? bodyCode[0] : null };
  } catch {
    return { ok: false, ngrokErrorCode: null };
  }
}

export const TUNNEL_WATCHDOG_INTERVAL_MS = 60_000;
// Two consecutive failed probes before warning: one failure can be a blip.
const TUNNEL_WATCHDOG_FAILURE_THRESHOLD = 2;

/**
 * The exact `SAMOGRAPH-WARNING` outage line — the single source of truth for the
 * text both the CLI watchdog and the server-side ingest watchdog (#81) emit, so
 * the wording never drifts. `cause` is an `ERR_NGROK_*` code or `"health check
 * failed"` (the fallback when a probe fails without one).
 */
export function tunnelUnreachableWarning(cause: string): string {
  return (
    `SAMOGRAPH-WARNING: tunnel unreachable (${cause}) - transcript may be ` +
    "incomplete; rejoin with --tunnel cloudflared or --webhook-base"
  );
}

/** The exact `SAMOGRAPH-WARNING` recovery line (shared with the ingest watchdog, #81). */
export const TUNNEL_RECOVERED_WARNING =
  "SAMOGRAPH-WARNING: tunnel recovered - live transcript delivery resumed";

export interface TunnelWatchdogHandle {
  /** Run one probe + state transition (exposed for tests; the schedule calls it). */
  tick(): Promise<void>;
  stop(): void;
}

export interface TunnelWatchdogOptions {
  /** Public tunnel base URL; falsy disables the watchdog entirely. */
  publicBase: string | null | undefined;
  transcriptPath: string;
  /** Append a line to the transcript (default: append to transcriptPath). */
  appendLine?: (line: string) => void;
  intervalMs?: number;
  fetch?: HealthFetch;
  nonce?: () => string;
  now?: () => Date;
  stderr?: (s: string) => void;
  schedule?: (fn: () => void, ms: number) => { stop(): void };
}

function fmtTranscriptTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function defaultSchedule(fn: () => void, ms: number): { stop(): void } {
  const timer = setInterval(fn, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Mid-call tunnel watchdog. Periodically probes the public URL against this
 * server. After 2 consecutive failures it appends a SAMOGRAPH-WARNING line to
 * the transcript file — formatted like a transcript line so `samograph watch`
 * relays it to the agent immediately — and mirrors it to stderr. It warns once
 * per outage and writes a single "tunnel recovered" line when probes succeed
 * again. This makes a mid-call ERR_NGROK_727-style outage loud instead of a
 * silently empty transcript.
 */
export function startTunnelWatchdog(
  options: TunnelWatchdogOptions,
): TunnelWatchdogHandle | null {
  const publicBase = (options.publicBase ?? "").replace(/\/+$/, "");
  if (!publicBase) return null;

  const fetchFn = options.fetch ?? fetch;
  const nonceFn = options.nonce ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const writeStderr =
    options.stderr ?? ((s: string) => void process.stderr.write(s));

  let consecutiveFailures = 0;
  let inOutage = false;

  const emit = (text: string): void => {
    const line = `[${fmtTranscriptTs(now())}] ${text}`;
    try {
      if (options.appendLine) options.appendLine(line);
      else appendFileSync(options.transcriptPath, line + "\n");
    } catch {
      // Transcript file may be gone (call torn down) — stderr still fires.
    }
    writeStderr(line + "\n");
  };

  const tick = async (): Promise<void> => {
    const probe = await probeTunnelHealth(publicBase, fetchFn, nonceFn);
    if (probe.ok) {
      consecutiveFailures = 0;
      if (inOutage) {
        inOutage = false;
        emit(TUNNEL_RECOVERED_WARNING);
      }
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= TUNNEL_WATCHDOG_FAILURE_THRESHOLD && !inOutage) {
      inOutage = true;
      const cause = probe.ngrokErrorCode ?? "health check failed";
      emit(tunnelUnreachableWarning(cause));
    }
  };

  const scheduled = (options.schedule ?? defaultSchedule)(
    () => void tick(),
    options.intervalMs ?? TUNNEL_WATCHDOG_INTERVAL_MS,
  );
  return { tick, stop: () => scheduled.stop() };
}

// Transcript-stream watchdog polls more often than the tunnel one: a provider
// failure (e.g. Deepgram `provider_connection_failed`) is a reported terminal
// status, not a flaky probe, so we want to surface it within ~20s rather than
// at the 60s tunnel cadence.
export const TRANSCRIPT_WATCHDOG_INTERVAL_MS = 20_000;

export interface TranscriptStreamStatus {
  /** Recall recording transcript status code, e.g. "processing" | "failed" | "done". */
  code: string | null;
  /** Recall sub_code, e.g. "provider_connection_failed". */
  subCode: string | null;
}

export interface TranscriptWatchdogHandle {
  /** Run one status poll + state transition (exposed for tests; the schedule calls it). */
  tick(): Promise<void>;
  stop(): void;
}

export interface TranscriptWatchdogOptions {
  /**
   * Fetches the current Recall transcript-stream status. Falsy disables the
   * watchdog entirely (e.g. no bot id available). Returning null means "no
   * status yet" (recording not started) and is treated as healthy.
   */
  fetchStatus:
    | (() => Promise<TranscriptStreamStatus | null>)
    | null
    | undefined;
  transcriptPath: string;
  /** Append a line to the transcript (default: append to transcriptPath). */
  appendLine?: (line: string) => void;
  intervalMs?: number;
  now?: () => Date;
  stderr?: (s: string) => void;
  schedule?: (fn: () => void, ms: number) => { stop(): void };
}

/**
 * Mid-call transcript-stream watchdog. The tunnel watchdog catches a dead
 * tunnel, but a *healthy* tunnel that delivers frames while the transcription
 * provider connection has failed looks, to the agent, exactly like "nobody has
 * spoken yet" — the bot sits deaf and silent. This watchdog polls Recall's
 * recording transcript status and, the moment it reports `failed`, appends a
 * SAMOGRAPH-WARNING line to the transcript file (so `samograph watch` relays it
 * immediately) and mirrors it to stderr. It warns once per outage and writes a
 * single recovery line if the stream comes back. Transient status-fetch errors
 * are ignored — only a reported `failed` status warns.
 */
export function startTranscriptWatchdog(
  options: TranscriptWatchdogOptions,
): TranscriptWatchdogHandle | null {
  const fetchStatus = options.fetchStatus;
  if (!fetchStatus) return null;

  const now = options.now ?? (() => new Date());
  const writeStderr =
    options.stderr ?? ((s: string) => void process.stderr.write(s));

  let inFailure = false;

  const emit = (text: string): void => {
    const line = `[${fmtTranscriptTs(now())}] ${text}`;
    try {
      if (options.appendLine) options.appendLine(line);
      else appendFileSync(options.transcriptPath, line + "\n");
    } catch {
      // Transcript file may be gone (call torn down) — stderr still fires.
    }
    writeStderr(line + "\n");
  };

  const tick = async (): Promise<void> => {
    let status: TranscriptStreamStatus | null;
    try {
      status = await fetchStatus();
    } catch {
      // Transient Recall API error — not a transcript failure; ignore.
      return;
    }
    if (!status || !status.code) return;

    if (status.code === "failed") {
      if (!inFailure) {
        inFailure = true;
        const sub = status.subCode ?? "unknown";
        emit(
          `SAMOGRAPH-WARNING: transcript stream failed (${sub}) - no transcript ` +
            "is being produced; check the transcription provider key/credits in " +
            "the Recall dashboard",
        );
      }
      return;
    }

    // Any non-failed status is healthy.
    if (inFailure) {
      inFailure = false;
      emit(
        "SAMOGRAPH-WARNING: transcript stream recovered - transcript delivery resumed",
      );
    }
  };

  const scheduled = (options.schedule ?? defaultSchedule)(
    () => void tick(),
    options.intervalMs ?? TRANSCRIPT_WATCHDOG_INTERVAL_MS,
  );
  return { tick, stop: () => scheduled.stop() };
}

/**
 * Extract the transcript-stream status from a Recall bot object
 * (`recordings[].media_shortcuts.transcript.status`). Returns the first
 * recording that carries a transcript status, or null when none is present yet
 * (e.g. recording not started). Defensive against the API shape changing.
 */
export function transcriptStatusFromBot(
  bot: unknown,
): TranscriptStreamStatus | null {
  if (typeof bot !== "object" || bot === null) return null;
  const recordings = (bot as { recordings?: unknown }).recordings;
  if (!Array.isArray(recordings)) return null;
  for (const rec of recordings) {
    const status = (
      rec as {
        media_shortcuts?: { transcript?: { status?: unknown } };
      }
    )?.media_shortcuts?.transcript?.status;
    if (status && typeof status === "object") {
      const code = (status as { code?: unknown }).code;
      if (typeof code === "string") {
        const sub = (status as { sub_code?: unknown }).sub_code;
        return { code, subCode: typeof sub === "string" ? sub : null };
      }
    }
  }
  return null;
}

/**
 * Constant-time token comparison. Both sides are hashed to a fixed length so
 * timingSafeEqual never leaks length information; empty/missing tokens never
 * match anything (fail closed).
 */
export function tokensEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Process a webhook payload, appending a formatted transcript line to the
 * transcript file when the payload is a spoken `transcript.data` event (with
 * words) or an incoming `participant_events.chat_message` (#188), which is
 * rendered with the ` (chat)` marker. Returns the appended line (or null when
 * the payload is neither), so the caller can drive presence "heard" activity.
 */
export async function handleWebhook(
  payload: unknown,
  transcriptPath: string,
  appendLine?: (line: string) => void,
): Promise<string | null> {
  const normalized = normalizeTranscriptEvent(payload);
  if (normalized !== null) {
    if (appendLine) appendLine(normalized.line);
    else appendFileSync(transcriptPath, normalized.line + "\n");
  }
  return normalized?.line ?? null;
}

export interface ServeOptions {
  webhookToken?: string | null;
  frameToken?: string | null;
  presenceToken?: string | null;
  presenceWriteToken?: string | null;
  /** Token for the local-only GET /transcript long-poll (header X-Samograph-Transcript-Token). */
  transcriptToken?: string | null;
  /** Shared numbered line log; serve() creates one when omitted. */
  transcriptLog?: TranscriptLog;
  currentCallId?: () => string | null;
}

/** Max seconds a GET /transcript long-poll may block. */
export const TRANSCRIPT_WAIT_CAP_SECONDS = 60;
/** SSE keepalive comment interval for GET /transcript/stream. */
export const TRANSCRIPT_SSE_KEEPALIVE_MS = 15_000;

// Headers a reverse proxy or tunnel (ngrok, cloudflared, localtunnel) adds.
// The tunnel client runs on this machine and connects to 127.0.0.1, so the
// peer address of a tunneled request is loopback too; these headers and the
// public Host are what tell it apart from a direct local request.
const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ray",
  "cdn-loop",
  "true-client-ip",
];
const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * True only for a request made directly on this machine: loopback peer,
 * a loopback Host header, and no proxy/tunnel forwarding headers. Requests
 * relayed through the public tunnel fail this check.
 */
export function isDirectLocalRequest(req: Request, peerAddress: string | null | undefined): boolean {
  if (!peerAddress || !LOOPBACK_ADDRS.has(peerAddress)) return false;
  for (const h of PROXY_HEADERS) {
    if (req.headers.has(h)) return false;
  }
  for (const name of req.headers.keys()) {
    if (name.startsWith("ngrok-") || name.startsWith("x-forwarded-")) return false;
  }
  const host = req.headers.get("host");
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return LOCAL_HOSTNAMES.has(hostname);
}

function wireEntry(e: TranscriptLogEntry): Omit<TranscriptLogEntry, "offset"> {
  return { seq: e.seq, ts: e.ts, speaker: e.speaker, text: e.text, line: e.line };
}

export interface LatestVideoFrame {
  raw: Uint8Array | null;
  metadata: VideoFrameMetadata | null;
}

function selectedFrame(
  latest: LatestVideoFrame,
  bySource: Map<string, LatestVideoFrame>,
  source?: string | null,
): LatestVideoFrame {
  const key = normalizeFrameSource(source);
  return key ? (bySource.get(key) ?? { raw: null, metadata: null }) : latest;
}

function frameInventory(bySource: Map<string, LatestVideoFrame>): VideoFrameMetadata[] {
  const seen = new Set<string>();
  const frames: VideoFrameMetadata[] = [];
  for (const frame of bySource.values()) {
    const sourceKey = frame.metadata?.source_key;
    if (!frame.metadata || !sourceKey || seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    frames.push(frame.metadata);
  }
  frames.sort((a, b) => String(a.source_key).localeCompare(String(b.source_key)));
  return frames;
}

export function callIdFromStateFile(path?: string | null): string | null {
  if (!path) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as { bot_id?: unknown };
    return typeof state.bot_id === "string" ? state.bot_id : null;
  } catch {
    return null;
  }
}

/**
 * Run the webhook server. Replaces the Python Flask server.
 * POST /webhook?token=<secret> -> handleWebhook, returns {ok:true}.
 */
export function serve(
  port: number,
  transcriptPath: string,
  options: ServeOptions | string | null = {},
) {
  const opts: ServeOptions =
    typeof options === "string" || options === null
      ? { webhookToken: options }
      : options;
  const latestVideoFrame: LatestVideoFrame = { raw: null, metadata: null };
  let presence: PresenceSnapshot = newPresenceSnapshot();
  const framesBySource = new Map<string, LatestVideoFrame>();
  const frameAuthorized = (req: Request): boolean =>
    tokensEqual(req.headers.get("X-Samograph-Frame-Token"), opts.frameToken);
  // The read token rides in the page URL handed to Recall, so it must never
  // grant write access; presence updates require the separate write token.
  // Only the HTML page accepts the query token (Recall navigates there and
  // cannot set headers); /presence.json requires the header.
  const presencePageAuthorized = (req: Request, url: URL): boolean =>
    tokensEqual(req.headers.get("X-Samograph-Presence-Token"), opts.presenceToken) ||
    tokensEqual(url.searchParams.get("token"), opts.presenceToken);
  const presenceJsonAuthorized = (req: Request): boolean =>
    tokensEqual(req.headers.get("X-Samograph-Presence-Token"), opts.presenceToken);
  const presenceWriteAuthorized = (req: Request): boolean =>
    tokensEqual(req.headers.get("X-Samograph-Presence-Token"), opts.presenceWriteToken);
  const transcriptLog = opts.transcriptLog ?? new TranscriptLog(transcriptPath);
  const appendLine = (line: string): void => void transcriptLog.append(line);
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    // Transport-layer cap: Bun answers 413 itself when Content-Length exceeds
    // this, before the fetch handler runs. Chunked (no Content-Length) bodies
    // are still buffered by Bun 1.3.x, so the in-handler byte checks below
    // remain as the guard for that path.
    maxRequestBodySize: WEBHOOK_MAX_BYTES,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/webhook") {
        if (!tokensEqual(url.searchParams.get("token"), opts.webhookToken)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const contentLength = req.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) > WEBHOOK_MAX_BYTES) {
          return Response.json({ error: "payload too large" }, { status: 413 });
        }
        let payload: unknown = {};
        try {
          const body = await req.text();
          if (new TextEncoder().encode(body).byteLength > WEBHOOK_MAX_BYTES) {
            return Response.json({ error: "payload too large" }, { status: 413 });
          }
          payload = body ? JSON.parse(body) : {};
        } catch {
          payload = {};
        }
        const transcriptLine = await handleWebhook(payload, transcriptPath, appendLine);
        if (transcriptLine !== null) {
          const activity = activityFromTranscriptLine(transcriptLine);
          if (activity !== null) {
            // Append the heard line and bump updated_at only; never reset the
            // agent-set state/message from transcript traffic.
            presence = appendPresenceActivity(presence, activity);
          }
        }
        return Response.json({ ok: true });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        // Deliberately unauthenticated: it returns nothing sensitive, and the
        // join-time/mid-call tunnel checks must work without leaking tokens.
        return Response.json({
          ok: true,
          nonce: url.searchParams.get("nonce") ?? "",
          marker: HEALTH_MARKER,
        });
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/transcript" || url.pathname === "/transcript/stream")
      ) {
        // Local-only: never served through the public tunnel, even with a
        // valid token. 404 (not 403) so the tunnel does not reveal it exists.
        if (!isDirectLocalRequest(req, server.requestIP(req)?.address)) {
          return new Response("Not Found", { status: 404 });
        }
        if (!tokensEqual(req.headers.get("X-Samograph-Transcript-Token"), opts.transcriptToken)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const sinceRaw = url.searchParams.get("since") ?? req.headers.get("Last-Event-ID") ?? "0";
        const since = Number(sinceRaw);
        if (!/^\d+$/.test(sinceRaw) || !Number.isSafeInteger(since)) {
          return Response.json({ error: "invalid since" }, { status: 400 });
        }
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          return Response.json({ error: "invalid limit" }, { status: 400 });
        }
        if (url.pathname === "/transcript/stream") {
          // Server-Sent Events: one event per line, id = seq, so a client can
          // reconnect with Last-Event-ID (or ?since=) and miss nothing.
          server.timeout(req, 0);
          let unsubscribe = (): void => {};
          let keepalive: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              const send = (s: string) => {
                try { controller.enqueue(enc.encode(s)); } catch { unsubscribe(); }
              };
              send(": samograph transcript stream\n\n");
              unsubscribe = transcriptLog.subscribe((e) => {
                send(`id: ${e.seq}\ndata: ${JSON.stringify({ ...wireEntry(e), offset: e.offset })}\n\n`);
              }, since);
              keepalive = setInterval(() => send(": keepalive\n\n"), TRANSCRIPT_SSE_KEEPALIVE_MS);
            },
            cancel() {
              unsubscribe();
              if (keepalive) clearInterval(keepalive);
            },
          });
          req.signal.addEventListener("abort", () => {
            unsubscribe();
            if (keepalive) clearInterval(keepalive);
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
            },
          });
        }
        const waitRaw = url.searchParams.get("wait") ?? "0";
        const waitSec = Number(waitRaw);
        if (!Number.isFinite(waitSec) || waitSec < 0) {
          return Response.json({ error: "invalid wait" }, { status: 400 });
        }
        const waitCapped = Math.min(waitSec, TRANSCRIPT_WAIT_CAP_SECONDS);
        // Bun's default idle timeout (10s) would cut a long-poll short.
        server.timeout(req, Math.ceil(waitCapped) + 10);
        const page = await transcriptLog.wait(since, waitCapped * 1000, limit);
        return Response.json(
          {
            lines: page.lines.map(wireEntry),
            next: page.next,
            offset: page.offset,
            reset: page.reset,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (req.method === "GET" && url.pathname === "/frame") {
        if (!frameAuthorized(req)) {
          return new Response("", { status: 403 });
        }
        const frame = selectedFrame(latestVideoFrame, framesBySource, url.searchParams.get("source"));
        if (frame.raw === null) {
          return new Response("", { status: 404 });
        }
        return new Response(frame.raw, {
          headers: { "Content-Type": "image/png" },
        });
      }
      if (req.method === "GET" && url.pathname === "/frame.json") {
        if (!frameAuthorized(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const frame = selectedFrame(latestVideoFrame, framesBySource, url.searchParams.get("source"));
        if (frame.metadata === null) {
          return Response.json({ error: "no frame" }, { status: 404 });
        }
        return Response.json(frame.metadata);
      }
      if (req.method === "GET" && url.pathname === "/frames.json") {
        if (!frameAuthorized(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json({ frames: frameInventory(framesBySource) });
      }
      if (req.method === "GET" && url.pathname === "/presence") {
        if (!presencePageAuthorized(req, url)) {
          return new Response("", { status: 403 });
        }
        return new Response(presencePageHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/presence.json") {
        if (!presenceJsonAuthorized(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(presence, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (req.method === "POST" && url.pathname === "/presence") {
        if (!presenceWriteAuthorized(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const contentLength = req.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) > WEBHOOK_MAX_BYTES) {
          return Response.json({ error: "payload too large" }, { status: 413 });
        }
        let payload: unknown = {};
        try {
          const body = await req.text();
          if (new TextEncoder().encode(body).byteLength > WEBHOOK_MAX_BYTES) {
            return Response.json({ error: "payload too large" }, { status: 413 });
          }
          payload = body ? JSON.parse(body) : {};
        } catch {
          payload = {};
        }
        const rawPayload = payload as { state?: unknown; message?: unknown };
        const state = normalizePresenceState(rawPayload.state);
        if (state === null) {
          return Response.json({ error: "invalid presence state" }, { status: 400 });
        }
        // Bare state toggles (no message in the payload, or one that
        // sanitizes to empty) take the default message and never land in
        // the Comments activity lane.
        const hasMessage =
          typeof rawPayload.message === "string" &&
          sanitizePresenceText(rawPayload.message) !== "";
        const message = hasMessage
          ? sanitizePresenceMessage(rawPayload.message, state)
          : defaultPresenceMessage(state);
        if (hasMessage) {
          presence = appendPresenceActivity(presence, {
            kind: activityKindForState(state),
            label: labelForPresenceState(state),
            text: message,
          });
        }
        presence = newPresenceSnapshot(
          state,
          message,
          presence.activities,
        );
        return Response.json({ ok: true, presence });
      }
      if (req.method === "POST" && url.pathname === "/chime") {
        if (!presenceWriteAuthorized(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        // No body needed — a chime is a pure transient signal. The page plays a
        // sound once per new chime timestamp.
        presence = withChime(presence);
        return Response.json({ ok: true, chime: presence.chime });
      }
      if (url.pathname === "/video-ws") {
        if (!tokensEqual(url.searchParams.get("token"), opts.frameToken)) {
          return new Response("", { status: 403 });
        }
        const upgraded = server.upgrade(req);
        if (upgraded) return undefined;
        return new Response("Upgrade Required", { status: 426 });
      }
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      message(_ws, message) {
        let payload: unknown;
        try {
          const text = typeof message === "string"
            ? message
            : Buffer.from(message).toString("utf-8");
          payload = JSON.parse(text);
        } catch {
          return;
        }
        const decoded: DecodedVideoFrame | null = decodeVideoSeparatePng(
          payload,
          opts.currentCallId?.() ?? null,
        );
        if (decoded === null) return;
        latestVideoFrame.raw = decoded.raw;
        latestVideoFrame.metadata = decoded.metadata;
        const frame = { raw: decoded.raw, metadata: decoded.metadata };
        for (const alias of frameSourceAliases(decoded.metadata)) {
          framesBySource.set(alias, frame);
        }
      },
    },
  });
}
