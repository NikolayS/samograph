/**
 * Real-Recall flag factory — unit suite (SPEC §4.4, §5.2, §5.9, §6.1; issue #88).
 *
 * The DEFAULT path stays the deterministic in-repo fake (§6.1), so CI/local need
 * NO key. The REAL `src/recall.ts` client is reached ONLY when `RECALL_LIVE`
 * (or its `RECALL_AI` alias) is truthy AND `RECALL_API_KEY` is set. No test here
 * touches the real network: the "live" cases inject a STUB `fetch`, so we assert
 * the exact `POST /bot/` request shape without any egress.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RECALL_BASE } from "../../src/config.ts";
import { BOT_NAME, publicWebhookBase, type CreateBotRequest } from "./index.ts";
import { mapLifecycleCode } from "../ingest/botLifecycle.ts";
import {
  isRecallLive,
  liveRecallClient,
  buildRealCreateBotPayload,
  getRecallClient,
} from "./recallClient.ts";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";
const PUBLIC = "https://samograph-main.samo.cat";
const SECRET = "ingsec_deadbeef";

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stub that records each call and returns a configurable response. */
function makeStubFetch(next: () => Response) {
  const calls: Captured[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    const h = (init.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(h)) headers[k] = h[k]!;
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave raw */
      }
    }
    calls.push({ url, method: init.method, headers, body });
    return next();
  };
  return { fetchFn, calls };
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `CreateBotRequest` whose `buildWebhookUrl` mirrors orchestrateJoin's. */
function reqWith(base: string, secret: string): CreateBotRequest {
  return {
    meetingUrl: MEETING_URL,
    botName: BOT_NAME,
    buildWebhookUrl: (id) => `${base}/webhook?bot=${id}&t=${secret}`,
  };
}

describe("isRecallLive — env flag parsing (default = fake)", () => {
  it("is false when neither RECALL_LIVE nor RECALL_AI is set (the CI default)", () => {
    expect(isRecallLive({})).toBe(false);
  });

  it("accepts the documented truthy values for RECALL_LIVE (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(isRecallLive({ RECALL_LIVE: v })).toBe(true);
    }
  });

  it("treats falsy/empty values as off", () => {
    for (const v of ["", "0", "false", "no", "off"]) {
      expect(isRecallLive({ RECALL_LIVE: v })).toBe(false);
    }
  });

  it("honors RECALL_AI as an alias (issue #88 acceptance #1/#2)", () => {
    expect(isRecallLive({ RECALL_AI: "1" })).toBe(true);
    expect(isRecallLive({ RECALL_AI: "0" })).toBe(false);
  });
});

describe("getRecallClient — flag OFF returns the deterministic fake (§6.1)", () => {
  it("uses the seed-derived fake and makes NO real call (no fetch invoked)", async () => {
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls += 1;
      return jsonResponse({});
    };
    const client = getRecallClient({ env: {}, fetch: fetchFn, seed: "call-A" });
    const captured: string[] = [];
    const created = await client.createBot({
      meetingUrl: MEETING_URL,
      botName: BOT_NAME,
      buildWebhookUrl: (id) => {
        captured.push(id);
        return `${PUBLIC}/webhook?bot=${id}&t=${SECRET}`;
      },
    });
    // Deterministic fake bot id (seed "call-A") — byte-stable, no network.
    expect(created.id).toBe("bot_493ddef7");
    expect(created.webhookUrl).toBe(`${PUBLIC}/webhook?bot=bot_493ddef7&t=${SECRET}`);
    expect(captured).toEqual(["bot_493ddef7"]);
    expect(fetchCalls).toBe(0);
  });
});

describe("buildRealCreateBotPayload — exact §5.9 + Deepgram + webhook shape", () => {
  it("sets bot_name, real-time Deepgram transcription, and the public webhook endpoint", () => {
    const payload = buildRealCreateBotPayload(reqWith(PUBLIC, SECRET)) as Record<string, any>;
    expect(payload.meeting_url).toBe(MEETING_URL);
    // §5.9: the bot's displayed name is exactly "samograph (recording)".
    expect(payload.bot_name).toBe("samograph (recording)");
    // Real-time transcription via Deepgram (Recall provider config).
    expect(payload.recording_config.transcript.provider.deepgram_streaming).toBeDefined();
    // Public webhook destination from PUBLIC_WEBHOOK_BASE carrying the ingest secret.
    const ep = payload.recording_config.realtime_endpoints[0];
    expect(ep.type).toBe("webhook");
    expect(ep.url).toBe(`${PUBLIC}/webhook?t=${SECRET}`);
    // Real-time endpoints accept transcript + participant events (NOT
    // `bot.status_change`, which 400s "not a valid choice"). The hosted bot
    // subscribes to spoken transcript AND incoming meeting chat (#188/#195), so
    // the web transcript can show `Name (chat):` — exactly the proven CLI shape
    // (`src/commands/join.ts`, which registers both on the realtime endpoint).
    expect(ep.events).toEqual(["transcript.data", "participant_events.chat_message"]);
  });
});

describe("getRecallClient — flag ON issues the real POST /bot/ (no egress, stub fetch)", () => {
  const KEY = "recall-key-live-123";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.RECALL_API_KEY;
    process.env.RECALL_API_KEY = KEY; // headers() in src/config.ts reads this
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.RECALL_API_KEY;
    else process.env.RECALL_API_KEY = saved;
  });

  it("POSTs the Deepgram payload to /bot/ and records the canonical ?bot=&t= URL", async () => {
    const { fetchFn, calls } = makeStubFetch(() => jsonResponse({ id: "bot_live_1" }));
    const client = getRecallClient({
      env: { RECALL_LIVE: "1", RECALL_API_KEY: KEY },
      fetch: fetchFn,
    });
    const created = await client.createBot(reqWith(PUBLIC, SECRET));

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Token ${KEY}`);
    const body = calls[0]!.body as Record<string, any>;
    expect(body.bot_name).toBe("samograph (recording)");
    expect(body.recording_config.transcript.provider.deepgram_streaming).toBeDefined();
    expect(body.recording_config.realtime_endpoints[0].url).toBe(`${PUBLIC}/webhook?t=${SECRET}`);
    // Transcript + incoming meeting-chat events on the real-time endpoint
    // (#188/#195); `bot.status_change` is NOT here (it 400s on realtime).
    expect(body.recording_config.realtime_endpoints[0].events).toEqual([
      "transcript.data",
      "participant_events.chat_message",
    ]);

    // The Recall-assigned id from the response, and the canonical §5.3 webhook URL.
    expect(created.id).toBe("bot_live_1");
    expect(created.webhookUrl).toBe(`${PUBLIC}/webhook?bot=bot_live_1&t=${SECRET}`);
  });

  it("liveRecallClient routes bot-worker verbs: sendChat → /send_chat_message/, leave → /leave_call/", async () => {
    const { fetchFn, calls } = makeStubFetch(() => jsonResponse({}));
    const client = liveRecallClient({
      env: { RECALL_LIVE: "1", RECALL_API_KEY: KEY },
      fetch: fetchFn,
    });
    await client.sendChat("bot_live_1", "hi");
    await client.leaveCall("bot_live_1");
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/bot_live_1/send_chat_message/`);
    expect(calls[0]!.body).toEqual({ message: "hi" });
    expect(calls[1]!.url).toBe(`${RECALL_BASE}/bot/bot_live_1/leave_call/`);
  });
});

describe("per-env webhook base flows into the created-bot realtime endpoint (#193)", () => {
  // The base app-api resolves at startup (server.ts) from the process env: on a
  // preview samohost injects BASE_URL=<the env's own host> while PUBLIC_WEBHOOK_BASE
  // stays prod. That resolved base is what the create-bot realtime endpoint must
  // carry — otherwise the preview bot streams its transcript to prod's webhook.
  const PREVIEW = "https://samograph-b.samo.cat";
  const PROD = "https://samograph.samo.team";
  const KEY = "recall-key-live-123";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.RECALL_API_KEY;
    process.env.RECALL_API_KEY = KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.RECALL_API_KEY;
    else process.env.RECALL_API_KEY = saved;
  });

  it("registers realtime_endpoints[0].url on the BASE_URL host, never prod", async () => {
    // 1) Resolve the base exactly as server.ts does — preview BASE_URL wins.
    const base = publicWebhookBase({ BASE_URL: PREVIEW, PUBLIC_WEBHOOK_BASE: PROD });
    expect(base).toBe(PREVIEW);

    // 2) Drive the real create-bot path (stub fetch, no egress) with that base.
    const { fetchFn, calls } = makeStubFetch(() => jsonResponse({ id: "bot_live_1" }));
    const client = getRecallClient({
      env: { RECALL_LIVE: "1", RECALL_API_KEY: KEY },
      fetch: fetchFn,
    });
    await client.createBot(reqWith(base!, SECRET));

    // 3) The POSTed realtime endpoint carries the preview host, not prod.
    const body = calls[0]!.body as Record<string, any>;
    const url = body.recording_config.realtime_endpoints[0].url as string;
    expect(url).toBe(`${PREVIEW}/webhook?t=${SECRET}`);
    expect(url.startsWith(PROD)).toBe(false);

    // 4) buildRealCreateBotPayload directly agrees (the pure shape assertion).
    const payload = buildRealCreateBotPayload(reqWith(base!, SECRET)) as Record<string, any>;
    expect(payload.recording_config.realtime_endpoints[0].url).toBe(`${PREVIEW}/webhook?t=${SECRET}`);
  });
});

describe("getRecallClient — flag ON but RECALL_API_KEY missing → clear startup error", () => {
  it("throws (no silent fallback to the fake) and never calls fetch", () => {
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls += 1;
      return jsonResponse({});
    };
    // env carries the flag but NO key — refuse to start the real path.
    expect(() => getRecallClient({ env: { RECALL_LIVE: "1" }, fetch: fetchFn })).toThrow(
      /RECALL_API_KEY/,
    );
    expect(() => liveRecallClient({ env: { RECALL_AI: "on" }, fetch: fetchFn })).toThrow(
      /RECALL_API_KEY/,
    );
    expect(fetchCalls).toBe(0);
  });
});

describe("§5.9 disclosure decision is independent of the Recall client (issue #88 #3)", () => {
  it("in_call_not_recording posts NO disclosure and leaves; in_call_recording posts it", () => {
    // The decision lives in pure mapLifecycleCode (ingest), upstream of whichever
    // client (fake or real) backs the worker — so swapping clients cannot change it.
    const norec = mapLifecycleCode("in_call_not_recording");
    expect(norec?.postDisclosure).toBe(false);
    expect(norec?.leave).toBe(true);
    const rec = mapLifecycleCode("in_call_recording");
    expect(rec?.postDisclosure).toBe(true);
    expect(rec?.leave).toBe(false);
  });
});
