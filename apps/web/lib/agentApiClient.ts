import { AppApiError, throwTyped } from "./apiError.ts";
export { AppApiError };

export type AgentProvider = "codex" | "claude-code" | "other";
export interface AgentGrantInput {
  provider: AgentProvider;
  native_session_id: string;
  label: string;
}
/** Owner-readable metadata. Never contains the capability credential. */
export interface AgentBinding extends AgentGrantInput {
  id: string;
  call_id: string;
  scopes: Array<"listen" | "act:chat">;
  expires_at: string;
  created_at: string;
  last_request_at: string | null;
  revoked_at: string | null;
}
export interface MintedAgentBinding extends AgentBinding { credential: string }
export interface AgentApiClient {
  mintBinding(callId: string, input: AgentGrantInput): Promise<MintedAgentBinding>;
  listBindings(callId: string): Promise<AgentBinding[]>;
  revokeBinding(callId: string, bindingId: string): Promise<void>;
}

export function createHttpAgentApiClient(baseUrl = ""): AgentApiClient {
  const path = (callId: string) => `${baseUrl}/calls/${encodeURIComponent(callId)}/agent-bindings`;
  return {
    async mintBinding(callId, input) {
      const res = await fetch(path(callId), {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: input.provider, native_session_id: input.native_session_id, label: input.label }),
      });
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      return await res.json() as MintedAgentBinding;
    },
    async listBindings(callId) {
      const res = await fetch(path(callId), { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      return (await res.json() as { bindings: AgentBinding[] }).bindings;
    },
    async revokeBinding(callId, bindingId) {
      const res = await fetch(`${path(callId)}/${encodeURIComponent(bindingId)}`, {
        method: "DELETE", credentials: "same-origin", cache: "no-store",
      });
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
    },
  };
}
