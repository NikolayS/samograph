import { test, expect } from 'bun:test';
import { validateAgentIdentity, type AgentIdentity } from '../src/hostedAgent.ts';
const identity:AgentIdentity={binding_id:'11111111-1111-4111-8111-111111111111',call_id:'22222222-2222-4222-8222-222222222222',provider:'codex',native_session_id:'native session'};
test('native session identity rejects HTTP-trimmed padding and preserves internal ASCII spaces',()=>{
 for(const native_session_id of [' native','native ',' native ']) expect(()=>validateAgentIdentity({...identity,native_session_id})).toThrow('Invalid agent identity');
 expect(()=>validateAgentIdentity(identity)).not.toThrow();
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCredentialStore, HostedAgentClient } from '../src/hostedAgent.ts';
const uppercase:AgentIdentity={binding_id:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',call_id:'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',provider:'codex',native_session_id:'native internal space'};
const canonical={...uppercase,binding_id:uppercase.binding_id.toLowerCase(),call_id:uppercase.call_id.toLowerCase()};
test('credential store canonicalizes call and binding UUIDs and loads either case',()=>{
 const directory=mkdtempSync(join(tmpdir(),'agent-case-'));const store=new AgentCredentialStore(directory);
 try{
  store.save({...uppercase,origin:'https://example.test',credential:'fixture-token'});
  expect(store.load(canonical)).toEqual({...canonical,origin:'https://example.test',credential:'fixture-token'});
  expect(store.load(uppercase)).toEqual({...canonical,origin:'https://example.test',credential:'fixture-token'});
  const saved=JSON.parse(readFileSync(join(directory,canonical.binding_id+'.json'),'utf8'));expect(saved.binding_id).toBe(canonical.binding_id);expect(saved.call_id).toBe(canonical.call_id);
  store.remove(uppercase);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('client canonicalizes UUID route and header identities without altering native session',async()=>{
 let url='',bindingHeader='',nativeHeader='';
 const client=new HostedAgentClient({...uppercase,origin:'https://example.test',credential:'fixture-token'},async(input,init)=>{url=String(input);const headers=new Headers(init?.headers);bindingHeader=headers.get('X-Samograph-Binding')!;nativeHeader=headers.get('X-Samograph-Session')!;return Response.json({binding:{id:canonical.binding_id,call_id:canonical.call_id,provider:'codex',native_session_id:canonical.native_session_id},status:'IN_CALL',ingest_degraded:false,lines:[],omitted:[],next_seq:0,has_more:false,truncated:false});});
 expect((await client.context()).binding.id).toBe(canonical.binding_id);expect(url).toBe(`https://example.test/calls/${canonical.call_id}/agent/context`);expect(bindingHeader).toBe(canonical.binding_id);expect(nativeHeader).toBe('native internal space');
});
