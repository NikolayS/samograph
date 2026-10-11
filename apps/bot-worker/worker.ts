/**
 * Bot-worker command/act HTTP surface (SPEC §5.8) — the v1 seam for the v2
 * AI-agent channel.
 *
 * A process-per-call worker binds to ONE `call_id` and exposes the five verbs
 * 1:1 with the CLI:
 *   - `POST /v1/call/:id/chat {message}`        → `src/recall.ts:sendChat`
 *   - `POST /v1/call/:id/presence {state, msg?}`→ `src/presence.ts` semantics
 *   - `GET  /v1/call/:id/frames`                → `src/frameStore.ts` inventory
 *   - `GET  /v1/call/:id/frame?source=…`        → one frame's PNG bytes
 *   - `POST /v1/call/:id/leave`                 → `src/recall.ts:leaveCall`
 *
 * Inbound calls authenticate with `Authorization: Bearer <per-instance secret>`,
 * compared in constant time via `src/server.ts:tokensEqual`. Auth is checked
 * BEFORE the bound-call check so a worker never reveals which call it serves to an
 * unauthenticated probe. In dev the worker binds to loopback and the secret alone
 * authenticates; mTLS is the production-only addition (§5.8). The Recall leg is a
 * narrow swappable port (the in-repo fake / a spy in tests, §6.1); presence and
 * frames are in-memory stores reusing the CLI's pure helpers.
 */
import { tokensEqual } from "../../src/server.ts";
import {
  newPresenceSnapshot,
  normalizePresenceState,
  sanitizePresenceMessage,
  appendPresenceActivity,
  activityKindForState,
  labelForPresenceState,
  defaultPresenceMessage,
  type PresenceSnapshot,
  type PresenceState,
} from "../../src/presence.ts";
import {
  frameSourceKey,
  normalizeFrameSource,
  type VideoFrameMetadata,
} from "../../src/frameStore.ts";

/** Narrow Recall port for the worker's act verbs (chat/leave). Closes over the
 * worker's own `bot_id`; backed by `src/recall.ts` in prod, a spy in tests. */
export interface WorkerRecallPort {
  sendChat(message: string): Promise<Response>;
  leaveCall(): Promise<Response>;
}

/** One decoded frame held in the worker's in-memory store. */
export interface WorkerFrame {
  raw: Uint8Array;
  metadata: VideoFrameMetadata;
}

/** In-memory presence store reusing the CLI's `src/presence.ts` semantics. */
export interface WorkerPresenceStore {
  get(): PresenceSnapshot;
  /** Apply a state (+optional message) update; returns the new snapshot. */
  set(state: PresenceState, message?: string | null): PresenceSnapshot;
}

/** In-memory frame store reusing the CLI's `src/frameStore.ts` source keys. */
export interface WorkerFrameStore {
  /** Ingest/seed a captured frame (keyed by its source). */
  put(frame: WorkerFrame): void;
  /** Frame metadata inventory, one row per source key (sorted, stable). */
  inventory(): VideoFrameMetadata[];
  /** The frame for a source alias (`screen`, `participant:100`, …); newest overall when omitted. */
  get(source?: string | null): WorkerFrame | null;
}

export interface CreateWorkerHandlerDeps {
  /** The single call this worker process is bound to (§5.8). */
  callId: string;
  /** Per-instance Bearer secret; inbound requests must present it (constant-time). */
  secret: string;
  /** Recall act port (chat/leave). */
  recall: WorkerRecallPort;
  /** Presence store; defaults to a fresh in-memory store. */
  presence?: WorkerPresenceStore;
  /** Frame store; defaults to a fresh in-memory store. */
  frames?: WorkerFrameStore;
}

/** Fresh in-memory presence store mirroring the CLI's `presence` verb semantics. */
export function inMemoryPresenceStore(): WorkerPresenceStore {
  let snapshot = newPresenceSnapshot();
  return {
    get: () => snapshot,
    set(state, message) {
      // Bare state toggle (no message): switch state with its default message and
      // add NO Comments entry. With a message: sanitize it and append a comment.
      const hasMessage = typeof message === "string" && message.trim().length > 0;
      const text = hasMessage
        ? sanitizePresenceMessage(message, state)
        : defaultPresenceMessage(state);
      let next = newPresenceSnapshot(state, text, snapshot.activities);
      if (hasMessage) {
        next = appendPresenceActivity(next, {
          kind: activityKindForState(state),
          label: labelForPresenceState(state),
          text,
        });
      }
      snapshot = next;
      return snapshot;
    },
  };
}

/** Fresh in-memory frame store keyed by `frameSourceKey`, tracking newest-overall. */
export function inMemoryFrameStore(): WorkerFrameStore {
  const bySource = new Map<string, WorkerFrame>();
  let latest: WorkerFrame | null = null;
  return {
    put(frame) {
      const key = frame.metadata.source_key ?? frameSourceKey(frame.metadata);
      bySource.set(key, frame);
      latest = frame;
    },
    inventory() {
      return [...bySource.values()]
        .map((f) => f.metadata)
        .sort((a, b) => String(a.source_key).localeCompare(String(b.source_key)));
    },
    get(source) {
      const key = normalizeFrameSource(source);
      if (!key) return latest;
      return bySource.get(key) ?? null;
    },
  };
}

const UNAUTHORIZED = () => new Response(null, { status: 401 });
const NOT_FOUND = () => new Response("not found", { status: 404 });
function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/** `/v1/call/:id/:verb` matcher → `{ id, verb }` or null. */
function matchVerb(pathname: string): { id: string; verb: string } | null {
  const m = pathname.match(/^\/v1\/call\/([^/]+)\/([^/]+)$/);
  return m ? { id: decodeURIComponent(m[1]), verb: m[2] } : null;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Bearer token from the `Authorization` header, or null. */
function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * Build the per-call command/act request handler for a worker bound to `callId`.
 * `/health` is unauthenticated; every `/v1/...` verb requires the Bearer secret.
 */
export function createWorkerHandler(
  deps: CreateWorkerHandlerDeps,
): (req: Request) => Promise<Response> {
  const { callId, secret, recall } = deps;
  const presence = deps.presence ?? inMemoryPresenceStore();
  const frames = deps.frames ?? inMemoryFrameStore();

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Unauthenticated liveness probe.
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    const route = matchVerb(url.pathname);
    if (!route) return NOT_FOUND();

    // Auth FIRST (before revealing whether this worker serves the requested call).
    if (!tokensEqual(bearer(req), secret)) return UNAUTHORIZED();

    // This worker is bound to exactly one call.
    if (route.id !== callId) return NOT_FOUND();

    // ── POST /v1/call/:id/chat {message} → recall.sendChat ───────────────────
    if (req.method === "POST" && route.verb === "chat") {
      const body = await readJson(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return badRequest("message is required");
      const upstream = await recall.sendChat(message);
      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: "chat failed", status: upstream.status }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ ok: true }, { status: 200 });
    }

    // ── POST /v1/call/:id/presence {state, message?} → presence store ────────
    if (req.method === "POST" && route.verb === "presence") {
      const body = await readJson(req);
      const state = normalizePresenceState(body.state);
      if (!state) return badRequest("invalid presence state");
      const message = typeof body.message === "string" ? body.message : null;
      const snapshot = presence.set(state, message);
      return Response.json(
        { state: snapshot.state, message: snapshot.message, updated_at: snapshot.updated_at },
        { status: 200 },
      );
    }

    // ── GET /v1/call/:id/frames → inventory ──────────────────────────────────
    if (req.method === "GET" && route.verb === "frames") {
      return Response.json({ frames: frames.inventory() }, { status: 200 });
    }

    // ── GET /v1/call/:id/frame?source=… → one frame's PNG bytes ──────────────
    if (req.method === "GET" && route.verb === "frame") {
      const frame = frames.get(url.searchParams.get("source"));
      if (!frame) return NOT_FOUND();
      return new Response(frame.raw, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-samograph-source-key": String(frame.metadata.source_key ?? ""),
        },
      });
    }

    // ── POST /v1/call/:id/leave → recall.leaveCall ───────────────────────────
    if (req.method === "POST" && route.verb === "leave") {
      const upstream = await recall.leaveCall();
      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: "leave failed", status: upstream.status }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ ok: true }, { status: 200 });
    }

    return NOT_FOUND();
  };
}
