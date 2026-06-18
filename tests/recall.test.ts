import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { makeRecallClient } from "../src/recall.ts";
import { RECALL_BASE } from "../src/config.ts";

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Build a fake fetch that records each call and returns a configurable response. */
function makeFakeFetch(next: () => Response) {
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
        // leave raw
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

describe("recall client URL/method/header contract", () => {
  const KEY = "test-key-123";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.RECALL_API_KEY;
    process.env.RECALL_API_KEY = KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.RECALL_API_KEY;
    else process.env.RECALL_API_KEY = saved;
  });

  it("RECALL_BASE is the us-east-1 v1 endpoint", () => {
    expect(RECALL_BASE).toBe("https://us-east-1.recall.ai/api/v1");
  });

  it("leaveCall -> POST .../bot/<id>/leave_call/", async () => {
    const { fetchFn, calls } = makeFakeFetch(() => jsonResponse({}));
    await makeRecallClient(fetchFn).leaveCall("bot-x");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/bot-x/leave_call/`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Token ${KEY}`);
  });

  it("getBot -> GET .../bot/<id>/", async () => {
    const { fetchFn, calls } = makeFakeFetch(() => jsonResponse({ id: "bot-x" }));
    const r = (await makeRecallClient(fetchFn).getBot("bot-x")) as { id: string };
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/bot-x/`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.Authorization).toBe(`Token ${KEY}`);
    expect(r.id).toBe("bot-x");
  });

  it("sendChat -> POST .../bot/<id>/send_chat_message/ with {message}", async () => {
    const { fetchFn, calls } = makeFakeFetch(() => jsonResponse({}));
    await makeRecallClient(fetchFn).sendChat("bot-x", "hi");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/bot-x/send_chat_message/`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ message: "hi" });
    expect(calls[0]!.headers.Authorization).toBe(`Token ${KEY}`);
  });

  it("outputAudio -> POST .../bot/<id>/output_audio/ with {kind, b64_data}", async () => {
    const { fetchFn, calls } = makeFakeFetch(() => jsonResponse({}));
    await makeRecallClient(fetchFn).outputAudio("bot-x", "QUJD");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/bot-x/output_audio/`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ kind: "mp3", b64_data: "QUJD" });
    expect(calls[0]!.headers.Authorization).toBe(`Token ${KEY}`);
  });

  it("screenshot -> GET .../bot/<id>/screenshot/", async () => {
    const { fetchFn, calls } = makeFakeFetch(() => jsonResponse({}));
    await makeRecallClient(fetchFn).screenshot("bot-x");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/bot-x/screenshot/`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.Authorization).toBe(`Token ${KEY}`);
  });

  it("createBot -> POST .../bot/ with the payload as JSON", async () => {
    const { fetchFn, calls } = makeFakeFetch(() => jsonResponse({ id: "bot-new" }));
    const payload = { meeting_url: "https://zoom.us/j/1", bot_name: "TARS" };
    const r = (await makeRecallClient(fetchFn).createBot(payload)) as {
      id: string;
    };
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${RECALL_BASE}/bot/`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual(payload);
    expect(calls[0]!.headers.Authorization).toBe(`Token ${KEY}`);
    expect(r.id).toBe("bot-new");
  });

  it("createBot throws on a non-ok response", async () => {
    const { fetchFn } = makeFakeFetch(
      () => new Response("nope", { status: 400 }),
    );
    await expect(makeRecallClient(fetchFn).createBot({})).rejects.toThrow(
      /bot creation failed/,
    );
  });

  it("getBot throws a clear Error (not a raw SyntaxError) on a non-JSON body", async () => {
    const { fetchFn } = makeFakeFetch(
      () => new Response("<html>not json</html>", { status: 200 }),
    );
    let caught: unknown;
    try {
      await makeRecallClient(fetchFn).getBot("bot-x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).not.toBe("SyntaxError");
    expect((caught as Error).message).toMatch(/get bot failed/);
  });

  it("getBot throws a clear Error on a non-ok response", async () => {
    const { fetchFn } = makeFakeFetch(
      () => new Response("server error", { status: 500 }),
    );
    await expect(makeRecallClient(fetchFn).getBot("bot-x")).rejects.toThrow(
      /get bot failed: 500/,
    );
  });
});

export {};
