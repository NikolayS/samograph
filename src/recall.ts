import { RECALL_BASE, headers } from "./config.ts";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface RecallClient {
  leaveCall(botId: string): Promise<Response>;
  getBot(botId: string): Promise<unknown>;
  sendChat(botId: string, message: string): Promise<Response>;
  screenshot(botId: string): Promise<Response>;
  createBot(payload: unknown): Promise<unknown>;
}

export function makeRecallClient(fetchFn: FetchFn = fetch): RecallClient {
  return {
    async leaveCall(botId: string): Promise<Response> {
      return fetchFn(`${RECALL_BASE}/bot/${botId}/leave_call/`, {
        method: "POST",
        headers: headers(),
        signal: AbortSignal.timeout(10000),
      });
    },

    async getBot(botId: string): Promise<unknown> {
      const r = await fetchFn(`${RECALL_BASE}/bot/${botId}/`, {
        method: "GET",
        headers: headers(),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`get bot failed: ${r.status} ${body}`);
      }
      try {
        return await r.json();
      } catch {
        throw new Error("get bot failed: invalid JSON response");
      }
    },

    async sendChat(botId: string, message: string): Promise<Response> {
      return fetchFn(`${RECALL_BASE}/bot/${botId}/send_chat_message/`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(10000),
      });
    },

    async screenshot(botId: string): Promise<Response> {
      return fetchFn(`${RECALL_BASE}/bot/${botId}/screenshot/`, {
        method: "GET",
        headers: headers(),
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
    },

    async createBot(payload: unknown): Promise<unknown> {
      const r = await fetchFn(`${RECALL_BASE}/bot/`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`recall.ai bot creation failed: ${r.status} ${body}`);
      }
      return r.json();
    },
  };
}
