import { appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { formatTranscriptLine } from "./transcript.ts";
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
  type PresenceSnapshot,
} from "./presence.ts";

export const WEBHOOK_MAX_BYTES = 1024 * 1024;

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
 * transcript file when the payload is a transcript.data event with words.
 */
export async function handleWebhook(
  payload: unknown,
  transcriptPath: string,
): Promise<string | null> {
  const line = formatTranscriptLine(payload);
  if (line !== null) {
    appendFileSync(transcriptPath, line + "\n");
  }
  return line;
}

export interface ServeOptions {
  webhookToken?: string | null;
  frameToken?: string | null;
  presenceToken?: string | null;
  presenceWriteToken?: string | null;
  currentCallId?: () => string | null;
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
    tokensEqual(req.headers.get("X-Samocall-Frame-Token"), opts.frameToken);
  // The read token rides in the page URL handed to Recall, so it must never
  // grant write access; presence updates require the separate write token.
  // Only the HTML page accepts the query token (Recall navigates there and
  // cannot set headers); /presence.json requires the header.
  const presencePageAuthorized = (req: Request, url: URL): boolean =>
    tokensEqual(req.headers.get("X-Samocall-Presence-Token"), opts.presenceToken) ||
    tokensEqual(url.searchParams.get("token"), opts.presenceToken);
  const presenceJsonAuthorized = (req: Request): boolean =>
    tokensEqual(req.headers.get("X-Samocall-Presence-Token"), opts.presenceToken);
  const presenceWriteAuthorized = (req: Request): boolean =>
    tokensEqual(req.headers.get("X-Samocall-Presence-Token"), opts.presenceWriteToken);
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
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
        const transcriptLine = await handleWebhook(payload, transcriptPath);
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
        // Bare state toggles (no message in the payload) take the default
        // message and never land in the Comments activity lane.
        const hasMessage = rawPayload.message !== undefined;
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
