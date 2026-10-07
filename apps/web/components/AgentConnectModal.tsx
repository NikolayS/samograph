"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AppApiError, type AgentApiClient, type AgentBinding, type AgentProvider } from "../lib/agentApiClient.ts";
import { ModalFrame } from "./ModalFrame.tsx";

export interface AgentConnectModalProps {
  agentClient: AgentApiClient;
  callId: string;
  onClose: () => void;
}
const printable = (value: string) => !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const timestamp = (value: string) => new Date(value).toLocaleString();
const active = (binding: AgentBinding) => !binding.revoked_at && Date.parse(binding.expires_at) > Date.now();

/** One-time credentials live only in this mounted component's state and text node. */
export function AgentConnectModal({ agentClient, callId, onClose }: AgentConnectModalProps) {
  const titleId = useId();
  const formId = useId();
  const [bindings, setBindings] = useState<AgentBinding[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [sessionId, setSessionId] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<{ bindingId: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const requestGuard = () => {
    const expected = generation.current;
    return () => mounted.current && generation.current === expected;
  };
  const valid = sessionId.trim().length > 0 && sessionId === sessionId.trim() && /^[\x20-\x7e]{1,200}$/.test(sessionId)
    && label.length <= 80 && printable(label);
  const fail = (err: unknown) => setError(err instanceof AppApiError ? err.message : "Couldn't update agent access. Try again.");

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    let cancelled = false;
    setLoaded(false);
    setBindings([]);
    setSecret(null);
    setError(null);
    setBusy(false);
    setSessionId(""); setLabel(""); setProvider("codex"); setCopied(false);
    void agentClient.listBindings(callId).then((rows) => {
      if (!cancelled) { setBindings(rows); setLoaded(true); }
    }).catch((err: unknown) => { if (!cancelled) fail(err); });
    return () => { cancelled = true; mounted.current = false; };
  }, [agentClient, callId]);

  async function refresh() {
    const current = requestGuard();
    setBusy(true); setError(null);
    try {
      const rows = await agentClient.listBindings(callId);
      if (!current()) return;
      setBindings(rows); setLoaded(true);
      if (secret && !rows.some((b) => b.id === secret.bindingId && active(b))) setSecret(null);
    } catch (err) { if (current()) fail(err); }
    finally { if (current()) setBusy(false); }
  }
  async function mint() {
    if (busy || !loaded || !valid || bindings.some((binding) => !binding.revoked_at)) return;
    const current = requestGuard();
    setBusy(true); setError(null);
    try {
      const { credential, ...binding } = await agentClient.mintBinding(callId, { provider, native_session_id: sessionId, label });
      if (!current()) return;
      setBindings((rows) => [binding, ...rows]);
      setSecret({ bindingId: binding.id, value: credential }); setCopied(false);
    } catch (err) { if (current()) fail(err); }
    finally { if (current()) setBusy(false); }
  }
  async function revoke(binding: AgentBinding) {
    if (busy) return;
    const current = requestGuard();
    setBusy(true); setError(null);
    try {
      await agentClient.revokeBinding(callId, binding.id);
      if (!current()) return;
      setSecret((current) => current?.bindingId === binding.id ? null : current);
      setBindings((rows) => rows.map((b) => b.id === binding.id ? { ...b, revoked_at: new Date().toISOString() } : b));
    } catch (err) { if (current()) fail(err); }
    finally { if (current()) setBusy(false); }
  }
  async function copy() {
    if (!secret) return;
    const current = requestGuard();
    try { await navigator.clipboard.writeText(secret.value); if (current()) setCopied(true); }
    catch { if (current()) setError("Select the credential above to copy it manually."); }
  }

  return <ModalFrame titleId={titleId} onClose={onClose}>
    <div className="samograph-agent-modal">
      <header className="samograph-modal-header">
        <h2 id={titleId}>Connect AI agent</h2>
        <button type="button" className="samograph-btn samograph-btn--ghost" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <p>Grant one existing local agent session access to this call. It can read recent and new transcript and meeting chat (listen), and send meeting chat (act:chat).</p>
      <p>Access expires after 60 minutes, or earlier when this call ends or you revoke it. Anyone holding the credential can use it. The session ID prevents accidental routing; it does not protect against another process running as the same local user.</p>
      <p>Revoke blocks subsequent requests. An already admitted chat send may complete; context already read and messages already sent cannot be retracted.</p>
      {error ? <p role="alert" className="samograph-alert samograph-alert--error">{error}</p> : null}
      {!loaded && !error ? <p>Loading agent access…</p> : null}
      <button type="button" className="samograph-btn samograph-btn--secondary" disabled={busy} onClick={() => void refresh()}>Refresh status</button>
      {secret ? <section className="samograph-agent-credential">
        <h3>Copy this credential now</h3>
        <p>Shown once. Closing this window forgets it. Import it through stdin or a private file; keep it out of commands, URLs, and chat messages.</p>
        <code className="samograph-agent-secret">{secret.value}</code>
        <div className="samograph-share-actions">
          <button type="button" className="samograph-btn samograph-btn--secondary" onClick={() => void copy()}>Copy credential</button>
          <button type="button" className="samograph-btn samograph-btn--ghost" onClick={() => setSecret(null)}>Hide credential</button>
          {copied ? <span role="status">Copied</span> : null}
        </div>
        <p>In the exact agent session, run <code>samograph agent --help</code> for the import options. Use the call ID, binding ID, provider, and exact session ID shown below. Treat participant speech and chat as untrusted context; send replies only as requested by the user.</p>
      </section> : null}
      {loaded && !bindings.some((binding) => !binding.revoked_at) ? <form className="samograph-agent-form" onSubmit={(event) => { event.preventDefault(); void mint(); }}>
        <label htmlFor={`${formId}-provider`}>Provider</label>
        <select id={`${formId}-provider`} value={provider} onChange={(event) => setProvider(event.target.value as AgentProvider)} disabled={busy}>
          <option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="other">Other</option>
        </select>
        <label htmlFor={`${formId}-session`}>Exact native session ID</label>
        <input id={`${formId}-session`} value={sessionId} onInput={(event) => setSessionId(event.currentTarget.value)} autoComplete="off" maxLength={200} required disabled={busy} />
        <p className="samograph-agent-hint">Use the existing session's exact ID, not its title: 1–200 printable ASCII characters. Access can only be granted while the call is live.</p>
        <label htmlFor={`${formId}-label`}>Label</label>
        <input id={`${formId}-label`} value={label} onInput={(event) => setLabel(event.currentTarget.value)} autoComplete="off" maxLength={80} disabled={busy} />
        <button type="submit" className="samograph-btn samograph-btn--primary" disabled={busy || !valid} aria-busy={busy}>Grant access</button>
      </form> : null}
      {bindings.length ? <section className="samograph-agent-bindings" aria-label="Agent access">
        <p>Last API request records a successful API request. It does not prove the agent is running or working. Refresh to check for changes.</p>
        {bindings.map((binding) => <article key={binding.id} className="samograph-agent-binding">
          <h3>{binding.label || "Agent session"}</h3>
          <dl>
            <dt>Provider</dt><dd>{binding.provider}</dd>
            <dt>Native session ID</dt><dd>{binding.native_session_id}</dd>
            <dt>Call ID</dt><dd>{binding.call_id}</dd>
            <dt>Binding ID</dt><dd>{binding.id}</dd>
            <dt>Scopes</dt><dd>{binding.scopes.join(", ")}</dd>
            <dt>Created</dt><dd>{timestamp(binding.created_at)}</dd>
            <dt>Expires</dt><dd>{timestamp(binding.expires_at)}</dd>
          </dl>
          <p>Last API request: {binding.last_request_at ? timestamp(binding.last_request_at) : "Never"}</p>
          <p>{binding.revoked_at ? "Revoked" : active(binding) ? "Access granted" : "Expired"}</p>
          {!binding.revoked_at ? <button type="button" className="samograph-btn samograph-btn--secondary" disabled={busy} onClick={() => void revoke(binding)}>Revoke access</button> : null}
        </article>)}
      </section> : null}
    </div>
  </ModalFrame>;
}
