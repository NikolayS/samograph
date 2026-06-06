import { appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { formatTranscriptLine } from "./transcript.ts";
import {
  decodeVideoSeparatePng,
  type DecodedVideoFrame,
  type VideoFrameMetadata,
} from "./frameStore.ts";
import {
  newPresenceSnapshot,
  normalizePresenceState,
  presencePageHtml,
  sanitizePresenceMessage,
  type PresenceSnapshot,
} from "./presence.ts";

export const WEBHOOK_MAX_BYTES = 1024 * 1024;

/**
 * Process a webhook payload, appending a formatted transcript line to the
 * transcript file when the payload is a transcript.data event with words.
 */
export async function handleWebhook(
  payload: unknown,
  transcriptPath: string,
): Promise<void> {
  const line = formatTranscriptLine(payload);
  if (line !== null) {
    appendFileSync(transcriptPath, line + "\n");
  }
}

export interface ServeOptions {
  webhookToken?: string | null;
  frameToken?: string | null;
  presenceToken?: string | null;
  currentCallId?: () => string | null;
}

export interface LatestVideoFrame {
  raw: Uint8Array | null;
  metadata: VideoFrameMetadata | null;
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
  const frameAuthorized = (req: Request): boolean =>
    Boolean(opts.frameToken) && req.headers.get("X-Samoagent-Frame-Token") === opts.frameToken;
  const presenceAuthorized = (req: Request, url: URL, allowQueryToken: boolean): boolean =>
    Boolean(opts.presenceToken) &&
    (
      req.headers.get("X-Samoagent-Presence-Token") === opts.presenceToken ||
      (allowQueryToken && url.searchParams.get("token") === opts.presenceToken)
    );
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/webhook") {
        if (!opts.webhookToken || url.searchParams.get("token") !== opts.webhookToken) {
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
        await handleWebhook(payload, transcriptPath);
        return Response.json({ ok: true });
      }
      if (req.method === "GET" && url.pathname === "/frame") {
        if (!frameAuthorized(req)) {
          return new Response("", { status: 403 });
        }
        if (latestVideoFrame.raw === null) {
          return new Response("", { status: 404 });
        }
        return new Response(latestVideoFrame.raw, {
          headers: { "Content-Type": "image/png" },
        });
      }
      if (req.method === "GET" && url.pathname === "/frame.json") {
        if (!frameAuthorized(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        if (latestVideoFrame.metadata === null) {
          return Response.json({ error: "no frame" }, { status: 404 });
        }
        return Response.json(latestVideoFrame.metadata);
      }
      if (req.method === "GET" && url.pathname === "/presence") {
        if (!presenceAuthorized(req, url, true)) {
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
        if (!presenceAuthorized(req, url, true)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(presence, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (req.method === "POST" && url.pathname === "/presence") {
        if (!presenceAuthorized(req, url, false)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        let payload: unknown = {};
        try {
          payload = await req.json();
        } catch {
          payload = {};
        }
        const rawPayload = payload as { state?: unknown; message?: unknown };
        const state = normalizePresenceState(rawPayload.state);
        if (state === null) {
          return Response.json({ error: "invalid presence state" }, { status: 400 });
        }
        presence = newPresenceSnapshot(
          state,
          sanitizePresenceMessage(rawPayload.message, state),
        );
        return Response.json({ ok: true, presence });
      }
      if (url.pathname === "/video-ws") {
        if (!opts.frameToken || url.searchParams.get("token") !== opts.frameToken) {
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
      },
    },
  });
}
