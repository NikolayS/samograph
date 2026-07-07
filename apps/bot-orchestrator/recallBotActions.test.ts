/**
 * PRODUCTION Recall bot-act adapter — §5.9 disclosure chat + clean leave
 * (SPEC §5.9, §4.4; issues #117 / #116 follow-up).
 *
 * Pure, always-run: fetch and env are INJECTED — no network, no key material
 * anywhere near these tests. The endpoint shapes are the CURRENT Recall API,
 * byte-identical to the proven daily-driver CLI client (`src/recall.ts`):
 *
 *   POST https://us-east-1.recall.ai/api/v1/bot/<id>/send_chat_message/  {message}
 *   POST https://us-east-1.recall.ai/api/v1/bot/<id>/leave_call/
 *
 * both with `Authorization: Token <RECALL_API_KEY>` from the injected env only.
 */
import { describe, it, expect } from "bun:test";
import {
  liveRecallBotActions,
  recallBotWorkerPort,
  type BotActions,
} from "./recallBotActions.ts";

/** Record every request the adapter makes; answer with a canned response. */
function capturingFetch(status = 200) {
  const seen: Array<{
    url: string;
    method: string | undefined;
    auth: string | undefined;
    body: string | undefined;
  }> = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({
      url,
      method: init?.method,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(status === 200 ? "{}" : "secret-ish body", { status });
  };
  return { seen, fetchFn };
}

// Obviously-fake key: the env is INJECTED — no real RECALL_API_KEY anywhere.
const env = { RECALL_API_KEY: "test-not-a-real-key" };

describe("liveRecallBotActions (real Recall endpoints, injected fetch)", () => {
  it("sendChat POSTs the exact send_chat_message endpoint with {message}", async () => {
    const { seen, fetchFn } = capturingFetch();
    const actions = liveRecallBotActions({ env, fetch: fetchFn });

    await actions.sendChat("bot_abc", "hello call");
    expect(seen).toEqual([
      {
        url: "https://us-east-1.recall.ai/api/v1/bot/bot_abc/send_chat_message/",
        method: "POST",
        auth: "Token test-not-a-real-key",
        body: JSON.stringify({ message: "hello call" }),
      },
    ]);
  });

  it("leave POSTs the exact leave_call endpoint (no body)", async () => {
    const { seen, fetchFn } = capturingFetch();
    const actions = liveRecallBotActions({ env, fetch: fetchFn });

    await actions.leave("bot_abc");
    expect(seen).toEqual([
      {
        url: "https://us-east-1.recall.ai/api/v1/bot/bot_abc/leave_call/",
        method: "POST",
        auth: "Token test-not-a-real-key",
        body: undefined,
      },
    ]);
  });

  it("refuses to act without a key — and never fires the request", async () => {
    const { seen, fetchFn } = capturingFetch();
    const actions = liveRecallBotActions({ env: {}, fetch: fetchFn });

    await expect(actions.sendChat("bot_abc", "x")).rejects.toThrow("RECALL_API_KEY is not set");
    await expect(actions.leave("bot_abc")).rejects.toThrow("RECALL_API_KEY is not set");
    expect(seen).toEqual([]);
  });

  it("surfaces an HTTP failure WITHOUT echoing the response body (no reflection)", async () => {
    const { fetchFn } = capturingFetch(502);
    const actions = liveRecallBotActions({ env, fetch: fetchFn });

    await expect(actions.sendChat("bot_abc", "x")).rejects.toThrow(
      "bot send_chat_message failed: HTTP 502",
    );
    await expect(actions.leave("bot_abc")).rejects.toThrow("bot leave_call failed: HTTP 502");
    try {
      await actions.sendChat("bot_abc", "x");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-ish");
    }
  });
});

describe("recallBotWorkerPort (call-id keyed BotWorkerPort over the bot-id actions)", () => {
  function spyActions(): BotActions & { chats: string[][]; leaves: string[] } {
    const chats: string[][] = [];
    const leaves: string[] = [];
    return {
      chats,
      leaves,
      async sendChat(botId, message) {
        chats.push([botId, message]);
      },
      async leave(botId) {
        leaves.push(botId);
      },
    };
  }

  it("resolves call → recall_bot_id and forwards chat/leave", async () => {
    const actions = spyActions();
    const port = recallBotWorkerPort(actions, async (callId) =>
      callId === "call-1" ? "bot_xyz" : null,
    );
    await port.chat("call-1", "the disclosure");
    await port.leave("call-1");
    expect(actions.chats).toEqual([["bot_xyz", "the disclosure"]]);
    expect(actions.leaves).toEqual(["bot_xyz"]);
  });

  it("throws (rather than silently skipping) when the call has no bot id", async () => {
    const actions = spyActions();
    const port = recallBotWorkerPort(actions, async () => null);
    await expect(port.chat("call-9", "x")).rejects.toThrow("no recall_bot_id");
    await expect(port.leave("call-9")).rejects.toThrow("no recall_bot_id");
    expect(actions.chats).toEqual([]);
    expect(actions.leaves).toEqual([]);
  });
});
