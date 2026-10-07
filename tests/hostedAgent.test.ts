import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { AgentCredentialStore, HostedAgentClient, canonicalAgentOrigin, type AgentIdentity } from "../src/hostedAgent.ts";

const identity: AgentIdentity = { binding_id: "11111111-1111-4111-8111-111111111111", call_id: "22222222-2222-4222-8222-222222222222", provider: "codex", native_session_id: "native-session-1" };
const dirs: string[] = [];
function store() { const dir = mkdtempSync(join(tmpdir(), "samo-agent-test-")); dirs.push(dir); return new AgentCredentialStore(join(dir, "credentials")); }
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, {recursive:true,force:true})));
const context = { binding: {id:identity.binding_id,call_id:identity.call_id,provider:identity.provider,native_session_id:identity.native_session_id}, status:"IN_CALL",ingest_degraded:false,lines:[],omitted:[],next_seq:0,has_more:false,truncated:false };

describe("hosted agent CLI", () => {
  test("requires exact identities and explicit chat request id; refuses token arguments", () => {
    const flags = ["--binding",identity.binding_id,"--call",identity.call_id,"--provider","codex","--session",identity.native_session_id];
    expect(parseArgs(["agent","context",...flags]).agent_action).toBe("context");
    expect(() => parseArgs(["agent","context"])).toThrow();
    expect(() => parseArgs(["agent","chat","hello",...flags])).toThrow();
    expect(() => parseArgs(["agent","connect",...flags,"--origin","https://example.test","--token","secret"])).toThrow();
    expect(() => parseArgs(["agent","context",...flags,"--after-seq","1e3"])).toThrow();
  });
  test("canonical HTTPS only; HTTP requires explicit literal loopback opt-in", () => {
    expect(canonicalAgentOrigin("https://EXAMPLE.test/")).toBe("https://example.test");
    for(const origin of ["https://u:p@example.test", "https://example.test/path", "https://example.test/?secret=x", "http://example.test", "http://localhost:1234"]) expect(() => canonicalAgentOrigin(origin)).toThrow();
    expect(canonicalAgentOrigin("http://127.0.0.1:1234",true)).toBe("http://127.0.0.1:1234");
    expect(() => canonicalAgentOrigin("http://127.0.0.1.evil.test",true)).toThrow();
  });
  test("credential store is separate, private, round-trips exact identity and disconnects only locally", () => {
    const s=store(); s.save({...identity,origin:"https://example.test",credential:"test-secret"});
    expect(s.load(identity).credential).toBe("test-secret");
    expect(statSync(s.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.directory,identity.binding_id+".json")).mode & 0o777).toBe(0o600);
    expect(() => s.load({...identity,native_session_id:"different"})).toThrow();
    s.remove(identity); expect(() => s.load(identity)).toThrow();
  });
  test("store rejects symlink entries and malformed private records", () => {
    const s=store(); s.save({...identity,origin:"https://example.test",credential:"test-secret"});
    const p=join(s.directory,identity.binding_id+".json"), target=join(s.directory,"target");
    writeFileSync(target,readFileSync(p),{mode:0o600}); rmSync(p); symlinkSync(target,p);
    expect(() => s.load(identity)).toThrow(); expect(() => s.save({...identity,origin:"https://example.test",credential:"new"})).toThrow();
    rmSync(p); writeFileSync(p,"{bad",{mode:0o600}); expect(() => s.load(identity)).toThrow("Invalid saved agent credential");
  });
  test("context uses only bounded agent route and exact identity headers; redirects disabled", async () => {
    let seen:RequestInit|undefined; let url="";
    const client=new HostedAgentClient({...identity,origin:"https://example.test",credential:"test-secret"},async(u,i)=>{ url=String(u);seen=i;return Response.json(context); });
    expect((await client.context(7)).binding.id).toBe(identity.binding_id);
    expect(url).toBe(`https://example.test/calls/${identity.call_id}/agent/context?after_seq=7`);
    expect(seen?.redirect).toBe("error");
    const h=new Headers(seen?.headers); expect(h.get("Authorization")).toBe("Bearer test-secret");
    expect(h.get("X-Samograph-Session")).toBe(identity.native_session_id);
    expect(h.get("X-Samograph-Binding")).toBe(identity.binding_id);
    expect(seen?.credentials).toBe("omit");
  });
  test("connect validation rejects mismatched target and never echoes upstream secrets", async () => {
    const client=new HostedAgentClient({...identity,origin:"https://example.test",credential:"test-secret"},async()=>Response.json({...context,binding:{...context.binding,native_session_id:"wrong"}}));
    await expect(client.context()).rejects.toThrow("Agent identity mismatch");
    const denied=new HostedAgentClient({...identity,origin:"https://example.test",credential:"test-secret"},async()=>new Response("test-secret",{status:403}));
    await expect(denied.context()).rejects.toThrow("Agent request denied (403)");
  });
  test("chat timeout is unknown, never automatically retried, and returns its request id", async () => {
    let calls=0; const request_id="33333333-3333-4333-8333-333333333333";
    const client=new HostedAgentClient({...identity,origin:"https://example.test",credential:"test-secret"},async()=>{ calls++;throw new Error("test-secret upstream error"); });
    expect(await client.chat("hello",request_id)).toEqual({request_id,outcome:"unknown"});
    expect(calls).toBe(1);
  });
  test("oversized context responses fail without rendering meeting content", async () => {
    const client=new HostedAgentClient({...identity,origin:"https://example.test",credential:"test-secret"},async()=>new Response("x".repeat(33000)));
    await expect(client.context()).rejects.toThrow("Agent response exceeds limit");
  });
});
