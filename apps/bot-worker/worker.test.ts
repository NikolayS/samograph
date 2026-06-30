/**
 * Bot-worker command/act HTTP surface (SPEC §5.8, §6.2 #9) — no DB.
 *
 * The process-per-call worker binds to one `call_id` and exposes the five verbs
 * 1:1 with the CLI: chat/presence/frames/frame/leave. Inbound calls authenticate
 * with `Authorization: Bearer <per-instance secret>` (constant-time, reusing
 * `src/server.ts:tokensEqual`). These tests pin the auth contract (#3 — secret
 * mismatch → 401) and the happy path (#5 — each verb invokes the right CLI-backed
 * port via a spy and returns 2xx). Network-free: the Recall leg is a spy port,
 * presence/frame are in-memory stores.
 */
import { describe, it, expect } from "bun:test";
import {
  createWorkerHandler,
  inMemoryPresenceStore,
  inMemoryFrameStore,
  type WorkerRecallPort,
} from "./worker.ts";
import type { VideoFrameMetadata } from "../../src/frameStore.ts";

const CALL_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_CALL_ID = "22222222-2222-2222-2222-222222222222";
const SECRET = "worker-instance-secret-deterministic-0001";

/** Spy Recall port — records chat messages + leave count, returns a 200. */
function spyRecall() {
  const seen = { chat: [] as string[], leave: 0 };
  const port: WorkerRecallPort = {
    async sendChat(message: string) {
      seen.chat.push(message);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async leaveCall() {
      seen.leave += 1;
      return new Response(null, { status: 200 });
    },
  };
  return { seen, port };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
function screenFrameMeta(): VideoFrameMetadata {
  return {
    event: "video_separate_png.data",
    call_id: CALL_ID,
    type: "screen_share",
    source_key: "type:screen_share",
    participant: { id: null, name: null, is_host: null },
    timestamp: null,
    raw_bytes: PNG_BYTES.byteLength,
  };
}

function makeHandler(over: Partial<Parameters<typeof createWorkerHandler>[0]> = {}) {
  const recall = spyRecall();
  const presence = inMemoryPresenceStore();
  const frames = inMemoryFrameStore();
  const handler = createWorkerHandler({
    callId: CALL_ID,
    secret: SECRET,
    recall: recall.port,
    presence,
    frames,
    ...over,
  });
  return { handler, recall, presence, frames };
}

function req(
  method: string,
  path: string,
  opts: { bearer?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://127.0.0.1:9999${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

describe("bot-worker command/act surface (§5.8 / §6.2 #9)", () => {
  it("GET /health → 200 'ok' (unauthenticated)", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", "/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  // ── #3: per-worker secret mismatch / missing bearer → 401 ──────────────────
  it("missing Authorization on a /v1 route → 401", async () => {
    const { handler, recall } = makeHandler();
    const res = await handler(req("POST", `/v1/call/${CALL_ID}/chat`, { body: { message: "hi" } }));
    expect(res.status).toBe(401);
    expect(recall.seen.chat).toEqual([]); // never reached the port
  });

  it("wrong Bearer secret → 401 (constant-time mismatch, #3)", async () => {
    const { handler, recall } = makeHandler();
    const res = await handler(
      req("POST", `/v1/call/${CALL_ID}/chat`, { bearer: "not-the-secret", body: { message: "hi" } }),
    );
    expect(res.status).toBe(401);
    expect(recall.seen.chat).toEqual([]);
  });

  it("auth is checked BEFORE the bound-call check (wrong secret + wrong call → 401, not 404)", async () => {
    const { handler } = makeHandler();
    const res = await handler(
      req("POST", `/v1/call/${OTHER_CALL_ID}/chat`, { bearer: "wrong", body: { message: "hi" } }),
    );
    expect(res.status).toBe(401);
  });

  it("authenticated request for a DIFFERENT call id → 404 (worker is bound to one call)", async () => {
    const { handler } = makeHandler();
    const res = await handler(
      req("POST", `/v1/call/${OTHER_CALL_ID}/chat`, { bearer: SECRET, body: { message: "hi" } }),
    );
    expect(res.status).toBe(404);
  });

  // ── #5: happy path — each verb invokes the right CLI-backed port, returns 2xx ─
  it("POST chat → invokes recall.sendChat with the message, returns 200", async () => {
    const { handler, recall } = makeHandler();
    const res = await handler(
      req("POST", `/v1/call/${CALL_ID}/chat`, { bearer: SECRET, body: { message: "hello call" } }),
    );
    expect(res.status).toBe(200);
    expect(recall.seen.chat).toEqual(["hello call"]);
  });

  it("POST chat with an empty message → 400 (no port call)", async () => {
    const { handler, recall } = makeHandler();
    const res = await handler(
      req("POST", `/v1/call/${CALL_ID}/chat`, { bearer: SECRET, body: { message: "   " } }),
    );
    expect(res.status).toBe(400);
    expect(recall.seen.chat).toEqual([]);
  });

  it("POST presence → updates the presence store, returns 200 with the new state", async () => {
    const { handler, presence } = makeHandler();
    const res = await handler(
      req("POST", `/v1/call/${CALL_ID}/presence`, {
        bearer: SECRET,
        body: { state: "thinking", message: "Checking logs" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; message: string };
    expect(body.state).toBe("thinking");
    expect(body.message).toBe("Checking logs");
    // The store actually advanced (the port was invoked, not bypassed).
    expect(presence.get().state).toBe("thinking");
  });

  it("POST presence with an invalid state → 400 (no state change)", async () => {
    const { handler, presence } = makeHandler();
    const res = await handler(
      req("POST", `/v1/call/${CALL_ID}/presence`, { bearer: SECRET, body: { state: "dancing" } }),
    );
    expect(res.status).toBe(400);
    expect(presence.get().state).toBe("listening"); // initial state untouched
  });

  it("GET frames → 200 with the in-memory inventory of source keys", async () => {
    const { handler, frames } = makeHandler();
    frames.put({ raw: PNG_BYTES, metadata: screenFrameMeta() });
    const res = await handler(req("GET", `/v1/call/${CALL_ID}/frames`, { bearer: SECRET }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frames: Array<{ source_key: string }> };
    expect(body.frames.map((f) => f.source_key)).toEqual(["type:screen_share"]);
  });

  it("GET frame?source=screen → 200 image/png with the stored bytes", async () => {
    const { handler, frames } = makeHandler();
    frames.put({ raw: PNG_BYTES, metadata: screenFrameMeta() });
    const res = await handler(req("GET", `/v1/call/${CALL_ID}/frame?source=screen`, { bearer: SECRET }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const got = new Uint8Array(await res.arrayBuffer());
    expect([...got]).toEqual([...PNG_BYTES]);
  });

  it("GET frame when none captured yet → 404", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", `/v1/call/${CALL_ID}/frame?source=screen`, { bearer: SECRET }));
    expect(res.status).toBe(404);
  });

  it("POST leave → invokes recall.leaveCall, returns 200", async () => {
    const { handler, recall } = makeHandler();
    const res = await handler(req("POST", `/v1/call/${CALL_ID}/leave`, { bearer: SECRET }));
    expect(res.status).toBe(200);
    expect(recall.seen.leave).toBe(1);
  });
});
