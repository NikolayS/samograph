import { AppApiError, type AgentApiClient, type AgentBinding, type AgentGrantInput, type MintedAgentBinding } from "./agentApiClient.ts";
import type { FailSpec } from "./fakeShareApiClient.ts";

export interface FakeAgentApiClientOptions {
  bindings?: AgentBinding[];
  now?: () => number;
  failMintWith?: FailSpec;
  failListWith?: FailSpec;
  failRevokeWith?: FailSpec;
}
export class FakeAgentApiClient implements AgentApiClient {
  readonly requests: Array<{ path: string; method: "GET" | "POST" | "DELETE"; body?: AgentGrantInput }> = [];
  private readonly bindings = new Map<string, AgentBinding>();
  private counter = 0;
  constructor(private readonly options: FakeAgentApiClientOptions = {}) {
    for (const binding of options.bindings ?? []) this.bindings.set(binding.id, structuredClone(binding));
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private fail(spec: FailSpec | undefined) {
    if (spec) throw new AppApiError(spec.code, spec.message, spec.retryable, spec.status);
  }
  async mintBinding(callId: string, input: AgentGrantInput): Promise<MintedAgentBinding> {
    this.requests.push({ path: `/calls/${callId}/agent-bindings`, method: "POST", body: { ...input } });
    this.fail(this.options.failMintWith);
    if ([...this.bindings.values()].some((b) => b.call_id === callId && !b.revoked_at && Date.parse(b.expires_at) > this.now())) {
      throw new AppApiError("SAMO-AGENT-ACTIVE", "Revoke the existing session first.", false, 409);
    }
    const id = `binding_${++this.counter}`;
    const binding: AgentBinding = { ...input, id, call_id: callId, scopes: ["listen", "act:chat"],
      created_at: new Date(this.now()).toISOString(), expires_at: new Date(this.now() + 60 * 60_000).toISOString(),
      last_request_at: null, revoked_at: null };
    this.bindings.set(id, binding);
    return { ...structuredClone(binding), credential: `fixture-credential-${this.counter}` };
  }
  async listBindings(callId: string): Promise<AgentBinding[]> {
    this.requests.push({ path: `/calls/${callId}/agent-bindings`, method: "GET" });
    this.fail(this.options.failListWith);
    return [...this.bindings.values()].filter((b) => b.call_id === callId).map((b) => structuredClone(b));
  }
  async revokeBinding(callId: string, bindingId: string): Promise<void> {
    this.requests.push({ path: `/calls/${callId}/agent-bindings/${bindingId}`, method: "DELETE" });
    this.fail(this.options.failRevokeWith);
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.call_id !== callId) throw new AppApiError("SAMO-AUTHZ-001", "Not allowed.", false, 403);
    binding.revoked_at ??= new Date(this.now()).toISOString();
  }
}
export function createFakeAgentApiClient(options?: FakeAgentApiClientOptions) { return new FakeAgentApiClient(options); }
