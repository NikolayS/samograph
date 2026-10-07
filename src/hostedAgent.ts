import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { samographDir } from "./config.ts";

export interface AgentIdentity {
  binding_id: string;
  call_id: string;
  provider: "codex" | "claude-code" | "other";
  native_session_id: string;
}
export interface AgentCredential extends AgentIdentity { origin: string; credential: string; allow_loopback_http?: boolean }
export interface AgentContext {
  binding: { id: string; call_id: string; provider: string; native_session_id: string };
  status: string; ingest_degraded: boolean;
  lines: Array<{ seq: number; ts: string; speaker: string | null; text: string; kind: "speech" | "chat" }>;
  omitted: Array<{ seq: number; reason: "oversized" }>;
  next_seq: number; has_more: boolean; truncated: boolean;
}
export interface AgentChatResult { request_id: string; outcome: "accepted" | "unknown" | "rejected" }
export const AGENT_RESPONSE_BYTES = 32 * 1024;
const RECORD_BYTES = 16 * 1024;
export const agentUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function validateAgentIdentity(value: AgentIdentity): void {
  if (!agentUuid(value.binding_id) || !agentUuid(value.call_id) || !["codex", "claude-code", "other"].includes(value.provider) ||
    typeof value.native_session_id !== "string" || !value.native_session_id.trim() || value.native_session_id !== value.native_session_id.trim() || value.native_session_id.length > 200 || /[\x00-\x1f\x7f-\uffff]/.test(value.native_session_id)) {
    throw new Error("Invalid agent identity");
  }
}

function canonicalIdentity<T extends AgentIdentity>(identity:T):T {
  validateAgentIdentity(identity);
  return {...identity,binding_id:identity.binding_id.toLowerCase(),call_id:identity.call_id.toLowerCase()};
}

/** The explicitly selected origin is the credential's trust anchor. Never follow redirects. */
export function canonicalAgentOrigin(value: string, allowLoopbackHttp = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid agent origin"); }
  if (!/^https?:\/\/[^/?#@]+\/?$/i.test(value) || value !== value.trim() || /[\\\x00-\x20\x7f]/.test(value) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) throw new Error("Invalid agent origin");
  const literalLoopback = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(value);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && literalLoopback)) throw new Error("Agent origin must use HTTPS (literal loopback HTTP needs explicit opt-in)");
  return url.origin;
}
function validateCredential(record: AgentCredential): void {
  validateAgentIdentity(record);
  canonicalAgentOrigin(record.origin, record.allow_loopback_http === true);
  if (typeof record.credential !== "string" || !record.credential || record.credential.length > 8192 || /[^\x21-\x7e]/.test(record.credential)) throw new Error("Invalid agent credential");
}
function sameIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return agentUuid(b.binding_id) && agentUuid(b.call_id) && a.binding_id.toLowerCase() === b.binding_id.toLowerCase() && a.call_id.toLowerCase() === b.call_id.toLowerCase() && a.provider === b.provider && a.native_session_id === b.native_session_id;
}
function owned(info: Stats): boolean { return process.getuid === undefined || info.uid === process.getuid(); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** Separate from local bot state. Possession by the same OS user still grants the capability. */
export class AgentCredentialStore {
  readonly directory: string;
  constructor(directory = process.env.SAMOGRAPH_AGENT_CREDENTIAL_DIR ?? join(samographDir(), "agent-credentials")) {
    const path = resolve(directory);
    // macOS's OS-owned /var and /tmp aliases are canonicalized first. All user
    // controlled symlink components, including the credential directory, remain rejected.
    this.directory = process.platform === "darwin" ? path.replace(/^\/(var|tmp)(?=\/|$)/, "/private/$1") : path;
  }
  private checkDirectory(create = false): void {
    // Inspect each component before mkdir, including existing ancestors. No symlink traversal.
    const root = parse(this.directory).root;
    let current = root;
    for (const part of this.directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      try {
        const info = lstatSync(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsafe agent credential directory");
      } catch (error) {
        if (!create || !missing(error)) throw new Error("Unsafe agent credential directory");
        mkdirSync(current, { mode: 0o700 });
      }
    }
    const info = lstatSync(this.directory);
    if (!owned(info) || (info.mode & 0o777) !== 0o700) throw new Error("Agent credential directory must be owned by you with mode 0700");
  }
  private path(identity: AgentIdentity): string { validateAgentIdentity(identity); return join(this.directory, `${identity.binding_id.toLowerCase()}.json`); }
  private checkFile(path: string): void {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !owned(info) || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > RECORD_BYTES) throw new Error("Unsafe saved agent credential");
  }
  save(record: AgentCredential): void {
    validateCredential(record);
    record = canonicalIdentity(record);
    this.checkDirectory(true);
    const path = this.path(record);
    try { this.checkFile(path); } catch (error) { if (!missing(error)) throw error; }
    const data = JSON.stringify({ ...record, origin: canonicalAgentOrigin(record.origin, record.allow_loopback_http === true) });
    if (Buffer.byteLength(data) > RECORD_BYTES) throw new Error("Agent credential exceeds limit");
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined;
      this.checkDirectory();
      try { this.checkFile(path); } catch (error) { if (!missing(error)) throw error; }
      renameSync(temporary, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
    }
  }
  load(identity: AgentIdentity): AgentCredential {
    identity = canonicalIdentity(identity);
    const path = this.path(identity);
    this.checkDirectory(); this.checkFile(path);
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || !owned(info) || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > RECORD_BYTES) throw new Error();
      const data = readFileSync(fd);
      if (data.length > RECORD_BYTES) throw new Error();
      const record = canonicalIdentity(JSON.parse(data.toString("utf8")) as AgentCredential);
      validateCredential(record);
      if (!sameIdentity(record, identity)) throw new Error();
      return record;
    } catch { throw new Error("Invalid saved agent credential"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  remove(identity: AgentIdentity): void {
    this.load(identity);
    this.checkDirectory(); this.checkFile(this.path(identity));
    unlinkSync(this.path(identity));
  }
}

export type AgentFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Invalid agent response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AGENT_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw new Error("Agent response exceeds limit"); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Agent response exceeds limit") throw error;
    throw new Error("Agent response unavailable");
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid agent response"); }
}

export class HostedAgentClient {
  private readonly record: AgentCredential;
  constructor(record: AgentCredential, private readonly fetchFn: AgentFetch = fetch) {
    validateCredential(record);
    this.record = { ...canonicalIdentity(record), origin: canonicalAgentOrigin(record.origin, record.allow_loopback_http === true) };
  }
  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const r = this.record;
    return this.fetchFn(`${r.origin}/calls/${r.call_id}/agent/${path}`, {
      ...init, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${r.credential}`, "X-Samograph-Binding": r.binding_id,
        "X-Samograph-Provider": r.provider, "X-Samograph-Session": r.native_session_id,
        ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
  }
  async context(afterSeq?: number): Promise<AgentContext> {
    if (afterSeq !== undefined && !integer(afterSeq)) throw new Error("Invalid context cursor");
    let response: Response;
    try { response = await this.request(`context${afterSeq === undefined ? "" : `?after_seq=${afterSeq}`}`); }
    catch { throw new Error("Agent request unavailable"); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Agent request denied (${response.status})`); }
    const page = await boundedJson(response) as AgentContext;
    const b = page?.binding;
    if (!b || !sameIdentity(this.record, { binding_id: b.id, call_id: b.call_id, provider: b.provider as AgentIdentity["provider"], native_session_id: b.native_session_id })) throw new Error("Agent identity mismatch");
    if (typeof page.status !== "string" || typeof page.ingest_degraded !== "boolean" || !integer(page.next_seq) || typeof page.has_more !== "boolean" || typeof page.truncated !== "boolean" ||
      !Array.isArray(page.lines) || !Array.isArray(page.omitted) || page.lines.length + page.omitted.length > 50 ||
      page.lines.some(l => !l || !integer(l.seq) || typeof l.ts !== "string" || !(l.speaker === null || typeof l.speaker === "string") || typeof l.text !== "string" || !["speech", "chat"].includes(l.kind)) ||
      page.omitted.some(l => !l || !integer(l.seq) || l.reason !== "oversized")) throw new Error("Invalid agent response");
    // Project known fields so an unexpected upstream error/debug field is never printed.
    return { binding: { id: b.id.toLowerCase(), call_id: b.call_id.toLowerCase(), provider: b.provider, native_session_id: b.native_session_id }, status: page.status, ingest_degraded: page.ingest_degraded,
      lines: page.lines.map(({seq,ts,speaker,text,kind}) => ({seq,ts,speaker,text,kind})), omitted: page.omitted.map(({seq,reason}) => ({seq,reason})), next_seq: page.next_seq, has_more: page.has_more, truncated: page.truncated };
  }
  async chat(text: string, requestId: string): Promise<AgentChatResult> {
    if (!agentUuid(requestId)) throw new Error("Invalid chat request ID");
    if (typeof text !== "string" || !text.trim() || text.length > 2000 || Buffer.byteLength(text) > 8192) throw new Error("Chat requires 1–2000 characters within 8 KiB");
    const unknown: AgentChatResult = { request_id: requestId, outcome: "unknown" };
    let response: Response;
    try { response = await this.request("chat", { method: "POST", body: JSON.stringify({ text, request_id: requestId }) }); }
    catch { return unknown; }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // A server/network failure after dispatch is ambiguous. Never resend here.
      if (response.status === 408 || response.status >= 500 || response.status >= 300 && response.status < 400) return unknown;
      throw new Error(`Agent request denied (${response.status})`);
    }
    let result: unknown;
    try { result = await boundedJson(response); } catch { return unknown; }
    const value = result as AgentChatResult;
    if (value?.request_id !== requestId || !["accepted", "unknown", "rejected", "submitted"].includes(value.outcome)) return unknown;
    return { request_id: requestId, outcome: value.outcome === ("submitted" as string) ? "unknown" : value.outcome };
  }
}
