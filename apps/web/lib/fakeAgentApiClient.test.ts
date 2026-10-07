import { test, expect } from 'bun:test';
import { createFakeAgentApiClient } from './fakeAgentApiClient.ts';
import { AppApiError, type AgentBinding } from './agentApiClient.ts';
const expired:AgentBinding={id:'expired-binding',call_id:'call_1',provider:'codex',native_session_id:'native',label:'Expired session',scopes:['listen','act:chat'],created_at:'2020-01-01T00:00:00Z',expires_at:'2020-01-01T01:00:00Z',last_request_at:null,revoked_at:null};
test('fake conflicts on expired unrevoked grants until explicit revoke',async()=>{
 const client=createFakeAgentApiClient({bindings:[expired]});const input={provider:'codex' as const,native_session_id:'new native',label:'New'};
 expect(await client.mintBinding('call_1',input).catch((error:AppApiError)=>error.status)).toBe(409);
 await client.revokeBinding('call_1',expired.id);expect((await client.mintBinding('call_1',input)).native_session_id).toBe('new native');
});
test('fake applies exact native identity transport validation without trimming',async()=>{
 const client=createFakeAgentApiClient();for(const native_session_id of [' native','native ',' native ','native-é','native\ncontrol']) expect(await client.mintBinding('call_1',{provider:'codex',native_session_id,label:'人間'}).catch((error:AppApiError)=>error.status)).toBe(400);
 expect((await client.mintBinding('call_1',{provider:'codex',native_session_id:'native internal space',label:'人間'})).native_session_id).toBe('native internal space');
});
