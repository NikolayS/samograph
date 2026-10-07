import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { cmdAgent, readAgentCredential } from "../src/commands/agent.ts";
import { AgentCredentialStore, HostedAgentClient, canonicalAgentOrigin } from "../src/hostedAgent.ts";

const identity = { binding_id: "11111111-1111-4111-8111-111111111111", call_id: "22222222-2222-4222-8222-222222222222", provider: "codex" as const, native_session_id: "native-session-1" };
const flags = ["--binding", identity.binding_id, "--call", identity.call_id, "--provider", identity.provider, "--session", identity.native_session_id];
const page = { binding: { id: identity.binding_id, call_id: identity.call_id, provider: identity.provider, native_session_id: identity.native_session_id }, status: "IN_CALL", ingest_degraded: false, lines: [{seq:1,ts:"2026-01-01T00:00:00Z",speaker:"Participant",text:"untrusted input",kind:"speech"}], omitted: [], next_seq: 1, has_more: false, truncated: false };
const dirs: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "samo-agent-cmd-")); dirs.push(root); return {root, store:new AgentCredentialStore(join(root,"credentials"))}; }
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, {recursive:true,force:true})));

describe("hosted agent commands", () => {
  test("connect verifies identity before save and context/chat/disconnect retain exact target", async () => {
    const {store} = fixture(); const outputs:string[]=[]; const requests:Array<{url:string;init?:RequestInit}>=[];
    const requestId = "33333333-3333-4333-8333-333333333333";
    const deps = {store,credentialInput:()=>"private-credential",output:(s:string)=>{outputs.push(s);},fetchFn:async(url:string|URL|Request,init?:RequestInit)=>{requests.push({url:String(url),init});return Response.json(init?.method==="POST"?{request_id:requestId,outcome:"accepted"}:page);}};
    await cmdAgent(parseArgs(["agent","connect",...flags,"--origin","https://example.test"]), deps);
    expect(store.load(identity).credential).toBe("private-credential");
    await cmdAgent(parseArgs(["agent","context",...flags,"--after-seq","0"]), deps);
    expect(JSON.parse(outputs[1]!).trust).toBe("untrusted_meeting_data");
    expect(JSON.parse(outputs[1]!).lines).toEqual(page.lines);
    await cmdAgent(parseArgs(["agent","chat","explicit reply",...flags,"--request-id",requestId]), deps);
    expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({text:"explicit reply",request_id:requestId});
    expect(JSON.parse(outputs[2]!)).toEqual({request_id:requestId,outcome:"accepted"});
    await cmdAgent(parseArgs(["agent","disconnect",...flags]), deps);
    expect(requests.length).toBe(3);
    expect(JSON.parse(outputs[3]!).remote_revoked).toBe(false);
    expect(outputs.join("")).not.toContain("private-credential");
    expect(() => store.load(identity)).toThrow();
  });
  test("failed verification never persists imported credential", async () => {
    const {store}=fixture();
    await expect(cmdAgent(parseArgs(["agent","connect",...flags,"--origin","https://example.test"]), {store,credentialInput:()=>"secret",fetchFn:async()=>Response.json({...page,binding:{...page.binding,id:"wrong"}})})).rejects.toThrow("Agent identity mismatch");
    expect(existsSync(store.directory)).toBe(false);
  });
  test("all agent parse errors omit supplied values and subprocess exits cleanly", async () => {
    for(const extra of [["--token=TOPSECRET"],["--token","TOPSECRET"],["--provider=TOPSECRET"],["--after-seq=TOPSECRET"],["TOPSECRET"]]) {
      try { parseArgs(["agent","context",...flags,...extra]);throw new Error("Unexpected success"); }
      catch(error) {expect(String(error)).not.toContain("TOPSECRET");}
    }
    const proc=Bun.spawn([process.execPath,"src/cli.ts","agent","connect",...flags,"--origin","https://example.test","--token=TOPSECRET"],{cwd:join(import.meta.dir,".."),stdout:"pipe",stderr:"pipe"});
    const stderr=await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2); expect(stderr).not.toContain("TOPSECRET"); expect(stderr.split("\n").length).toBe(2);
  });
  test("credential import rejects links, public permissions, and oversized input", () => {
    const {root}=fixture(); const file=join(root,"credential");
    writeFileSync(file,"private-value\n",{mode:0o600}); expect(readAgentCredential(file)).toBe("private-value");
    const linked=join(root,"link");symlinkSync(file,linked);expect(()=>readAgentCredential(linked)).toThrow();
    chmodSync(file,0o644);expect(()=>readAgentCredential(file)).toThrow();
    chmodSync(file,0o600);writeFileSync(file,"x".repeat(9000));expect(()=>readAgentCredential(file)).toThrow();
  });
  test("store rejects directory symlinks and broad file/directory permissions", () => {
    const {root,store}=fixture();const record={...identity,origin:"https://example.test",credential:"private-value"};
    store.save(record);const file=join(store.directory,identity.binding_id+".json");
    chmodSync(file,0o644);expect(()=>store.load(identity)).toThrow();chmodSync(file,0o600);
    chmodSync(store.directory,0o755);expect(()=>store.load(identity)).toThrow();chmodSync(store.directory,0o700);
    const alias=join(root,"alias");symlinkSync(store.directory,alias);expect(()=>new AgentCredentialStore(alias).save(record)).toThrow();
    expect(readFileSync(file,"utf8")).toContain("private-value");
  });
  test("context stream is cancelled at byte bound before reading all chunks", async () => {
    let read=0,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){read++;controller.enqueue(new Uint8Array(8192));},cancel(){cancelled=true;}});
    const client=new HostedAgentClient({...identity,origin:"https://example.test",credential:"secret"},async()=>new Response(stream));
    await expect(client.context()).rejects.toThrow("Agent response exceeds limit");
    expect(cancelled).toBe(true);expect(read).toBeLessThan(8);
  });
  test("ambiguous and malformed chat responses preserve ID and do not resend", async () => {
    const id="33333333-3333-4333-8333-333333333333";
    for(const response of [new Response("secret",{status:502}),Response.json({request_id:id,outcome:"submitted"}),Response.json({request_id:"wrong",outcome:"accepted"}),new Response("not JSON")]) {
      let calls=0;const client=new HostedAgentClient({...identity,origin:"https://example.test",credential:"secret"},async()=>{calls++;return response;});
      expect(await client.chat("hello",id)).toEqual({request_id:id,outcome:"unknown"});expect(calls).toBe(1);
    }
  });
  test("literal loopback rejects normalized or hostname aliases", () => {
    for(const origin of ["http://localhost:1234","http://127.1:1234","http://2130706433:1234","http://127.0.0.1.evil.test:1234","https://example.test/?","https://example.test/#","https://example.test\\"]) expect(()=>canonicalAgentOrigin(origin,true)).toThrow();
    expect(canonicalAgentOrigin("http://[::1]:1234",true)).toBe("http://[::1]:1234");
  });
  test("origin selection rejects normalized paths and empty userinfo", () => {
    for(const origin of ["https:example.test","https://example.test/.","https://example.test/path/..","https://example.test/%2e","https://@example.test"]) expect(()=>canonicalAgentOrigin(origin)).toThrow();
  });
  test("chat transport timeout response is an unknown delivery outcome", async () => {
    const id="33333333-3333-4333-8333-333333333333";
    const client=new HostedAgentClient({...identity,origin:"https://example.test",credential:"secret"},async()=>new Response("secret",{status:408}));
    expect(await client.chat("hello",id)).toEqual({request_id:id,outcome:"unknown"});
  });
});
