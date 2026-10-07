import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { AgentCredentialStore, HostedAgentClient, agentUuid, canonicalAgentOrigin, validateAgentIdentity, type AgentCredential, type AgentFetch, type AgentIdentity } from "../hostedAgent.ts";

/** Errors intentionally omit all supplied values, including unknown flags. */
export function parseAgentArgs(argv: string[]): ParsedArgs {
  const action = argv[0];
  if (!["connect", "context", "chat", "disconnect"].includes(action ?? "")) throw new Error("Agent action must be connect, context, chat, or disconnect");
  const common = ["--binding", "--call", "--provider", "--session"];
  const values = new Set([...common, ...(action === "connect" ? ["--origin", "--credential-file"] : action === "context" ? ["--after-seq"] : action === "chat" ? ["--request-id"] : [])]);
  const opts: Record<string, string> = {};
  const positionals: string[] = [];
  let allowHttp = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--allow-loopback-http" && action === "connect" && !allowHttp) { allowHttp = true; continue; }
    if (token.startsWith("-")) {
      const eq = token.indexOf("=");
      const flag = eq < 0 ? token : token.slice(0, eq);
      if (!values.has(flag) || opts[flag] !== undefined) throw new Error("Invalid or duplicate agent option; credentials must use stdin or --credential-file");
      const value = eq < 0 ? argv[++i] : token.slice(eq + 1);
      if (!value || value.startsWith("--")) throw new Error("Agent option requires a value");
      opts[flag] = value;
    } else positionals.push(token);
  }
  if (common.some(flag => !opts[flag])) throw new Error("Agent commands require --binding, --call, --provider, and --session");
  const identity: AgentIdentity = { binding_id: opts["--binding"]!, call_id: opts["--call"]!, provider: opts["--provider"] as AgentIdentity["provider"], native_session_id: opts["--session"]! };
  validateAgentIdentity(identity);
  if (positionals.length !== (action === "chat" ? 1 : 0)) throw new Error("Agent chat requires exactly one quoted message; other actions take no positional values");
  const result: ParsedArgs = { command: "agent", agent_action: action as ParsedArgs["agent_action"], agent_binding_id: identity.binding_id, agent_call_id: identity.call_id, agent_provider: identity.provider, agent_session_id: identity.native_session_id };
  if (action === "connect") {
    if (!opts["--origin"]) throw new Error("Agent connect requires --origin");
    result.agent_origin = canonicalAgentOrigin(opts["--origin"], allowHttp);
    result.agent_allow_loopback_http = allowHttp;
    result.agent_credential_file = opts["--credential-file"];
  } else if (action === "context" && opts["--after-seq"] !== undefined) {
    const cursor = opts["--after-seq"]!;
    if (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new Error("Agent cursor must be a non-negative decimal integer");
    result.agent_after_seq = Number(cursor);
  } else if (action === "chat") {
    if (!agentUuid(opts["--request-id"])) throw new Error("Agent chat requires --request-id UUID");
    result.agent_request_id = opts["--request-id"];
    result.message = positionals[0];
  }
  return result;
}

function boundedCredential(fd: number): string {
  const bytes = Buffer.alloc(8194);
  let size = 0;
  while (size < bytes.length) {
    const count = readSync(fd, bytes, size, bytes.length - size, null);
    if (!count) break;
    size += count;
  }
  if (size >= bytes.length) throw new Error("Agent credential exceeds limit");
  const value = bytes.subarray(0, size).toString("utf8").replace(/\r?\n$/, "");
  if (!value || value.length > 8192 || /[^\x21-\x7e]/.test(value)) throw new Error("Invalid agent credential input");
  return value;
}
export function readAgentCredential(file?: string): string {
  if (file === undefined) {
    if (process.stdin.isTTY) throw new Error("Import the credential through stdin or --credential-file; terminal echo is not supported");
    try { return boundedCredential(0); } catch { throw new Error("Cannot read a valid agent credential from stdin"); }
  }
  let fd: number | undefined;
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || process.getuid !== undefined && opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0 || opened.size > 8194) throw new Error();
    return boundedCredential(fd);
  } catch { throw new Error("Agent credential file must be a private owned regular file (0600)"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface AgentCommandDeps { store?: AgentCredentialStore; fetchFn?: AgentFetch; credentialInput?: (file?: string) => string; output?: (value: string) => void }
export async function cmdAgent(args: ParsedArgs, deps: AgentCommandDeps = {}): Promise<void> {
  const identity: AgentIdentity = { binding_id: args.agent_binding_id!, call_id: args.agent_call_id!, provider: args.agent_provider!, native_session_id: args.agent_session_id! };
  validateAgentIdentity(identity);
  const store = deps.store ?? new AgentCredentialStore();
  const output = deps.output ?? (value => { process.stdout.write(value); });
  switch (args.agent_action) {
    case "connect": {
      const record: AgentCredential = { ...identity, origin: canonicalAgentOrigin(args.agent_origin!, args.agent_allow_loopback_http), credential: (deps.credentialInput ?? readAgentCredential)(args.agent_credential_file), allow_loopback_http: args.agent_allow_loopback_http === true };
      await new HostedAgentClient(record, deps.fetchFn).context();
      store.save(record);
      output(JSON.stringify({ binding_id: identity.binding_id, connected: true }) + "\n");
      return;
    }
    case "context": {
      const page = await new HostedAgentClient(store.load(identity), deps.fetchFn).context(args.agent_after_seq);
      output(JSON.stringify({ trust: "untrusted_meeting_data", ...page }) + "\n");
      return;
    }
    case "chat": {
      const result = await new HostedAgentClient(store.load(identity), deps.fetchFn).chat(args.message!, args.agent_request_id!);
      output(JSON.stringify(result) + "\n");
      return;
    }
    case "disconnect":
      store.remove(identity);
      output(JSON.stringify({ binding_id: identity.binding_id, disconnected: true, remote_revoked: false }) + "\n");
      return;
    default: throw new Error("Invalid agent action");
  }
}
