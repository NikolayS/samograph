/**
 * PRODUCTION Recall bot-act adapter — the §5.9 disclosure chat + clean leave
 * (SPEC §5.9, §4.4; issue #117, found in review of #116).
 *
 * The ingest lifecycle handler and the status poller need two ACT verbs against
 * the real bot: post the in-call recording disclosure and make the bot leave
 * cleanly. This module is the real-Recall implementation of that seam, calling
 * the CURRENT Recall API — byte-identical to the proven daily-driver CLI client
 * (`src/recall.ts`, in production use on real calls):
 *
 *   POST ${RECALL_BASE}/bot/<bot_id>/send_chat_message/   body {"message": …}
 *   POST ${RECALL_BASE}/bot/<bot_id>/leave_call/          (no body)
 *
 * (Recall's leave is a POST, not a DELETE — confirmed against `src/recall.ts`.)
 *
 * §4.4 Recall-key boundary: `RECALL_API_KEY` is read from the INJECTED env at
 * request time and appears ONLY in the `Authorization: Token …` header — never
 * in logs, error messages, or return values. An HTTP failure surfaces the
 * status code only (no response-body echo — defense in depth against
 * reflection). Tests inject a fake fetch + fake env: no network, no key.
 */
import { RECALL_BASE } from "../../src/config.ts";
import type { FetchFn } from "../../src/recall.ts";
import type { BotWorkerPort } from "../ingest/botLifecycle.ts";

/**
 * The bot-id-keyed act port (the poller already holds `recall_bot_id`).
 * Implemented by {@link liveRecallBotActions} in production and by an inline
 * spy in tests (§6.1 — no key, no network on any PR).
 */
export interface BotActions {
  /** Post one chat message into the call (`send_chat_message`, §5.9). */
  sendChat(botId: string, message: string): Promise<void>;
  /** Make the bot leave the call cleanly (`leave_call`, §5.9). */
  leave(botId: string): Promise<void>;
  /**
   * Erase the bot's recorded media at Recall (`delete_media`, §5.14 GDPR per-call
   * erasure). A POST to `${RECALL_BASE}/bot/<bot_id>/delete_media/` — Recall's
   * documented endpoint to delete a bot's stored recording/transcript. Same
   * key-boundary + no-body-echo rules as the other acts.
   */
  deleteRecording(botId: string): Promise<void>;
}

/** Injectable seams (the `liveBotStatusSource` pattern in `statusPoller.ts`). */
export interface LiveRecallBotActionsDeps {
  /** Fetch for the real call (a stub in tests, the global `fetch` in prod). */
  fetch?: FetchFn;
  /** Environment to read `RECALL_API_KEY` from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** The production {@link BotActions} against the real Recall API. */
export function liveRecallBotActions(deps: LiveRecallBotActionsDeps = {}): BotActions {
  const fetchFn = deps.fetch ?? fetch;

  async function post(botId: string, verb: string, body?: unknown): Promise<void> {
    const env = deps.env ?? process.env;
    const key = (env.RECALL_API_KEY ?? "").trim();
    if (!key) throw new Error("RECALL_API_KEY is not set — cannot act on the bot");
    const r = await fetchFn(`${RECALL_BASE}/bot/${encodeURIComponent(botId)}/${verb}/`, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    // Deliberately no response-body echo (the caller's warn log / audit trail
    // must never carry anything Recall might reflect).
    if (!r.ok) throw new Error(`bot ${verb} failed: HTTP ${r.status}`);
  }

  return {
    sendChat: (botId, message) => post(botId, "send_chat_message", { message }),
    leave: (botId) => post(botId, "leave_call"),
    deleteRecording: (botId) => post(botId, "delete_media"),
  };
}

/**
 * Adapt the bot-id-keyed {@link BotActions} to the ingest lifecycle's
 * call-id-keyed {@link BotWorkerPort} seam (§94/§5.9): resolve the call's
 * `recall_bot_id` (privileged lookup) and forward. A call without a bot id
 * THROWS — inside the lifecycle dedup tx that rolls the transition back for a
 * clean Recall retry, never a silent consent skip.
 */
export function recallBotWorkerPort(
  actions: BotActions,
  resolveBotId: (callId: string) => Promise<string | null>,
): BotWorkerPort {
  async function botIdOf(callId: string): Promise<string> {
    const botId = await resolveBotId(callId);
    if (!botId) throw new Error(`no recall_bot_id for call ${callId} — cannot act on the bot`);
    return botId;
  }
  return {
    async chat(callId, message) {
      await actions.sendChat(await botIdOf(callId), message);
    },
    async leave(callId) {
      await actions.leave(await botIdOf(callId));
    },
  };
}
