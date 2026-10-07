import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { connect } from '../../../packages/shared/db/client.ts';
import { migrate } from '../../../packages/shared/db/migrate.ts';
import { verifyTokenSignature } from '../../../packages/shared/tokens/signing.ts';
import { mintToken } from '../../../packages/shared/tokens/store.ts';
import { sha256Hex } from '../../../packages/shared/crypto.ts';
import { signSession } from '../auth/session.ts';
import { createAccountHandler } from '../account/http.ts';
import { InMemoryEmailSender } from '../auth/index.ts';
import { purgeCallRows } from '../calls/erase.ts';
import { createAgentsHandler } from './http.ts';

const suite=process.env.DATABASE_URL?describe:describe.skip;
suite('hosted agent durable acceptance',()=>{
 const sql=connect(),secret='accept-session',key={kid:'accept',secret:'accept-token'};
 const fixtures:Array<{user:string;tenant:string}>=[];
 beforeAll(async()=>{await migrate(sql);});
 afterAll(async()=>{for(const f of fixtures){await sql`DELETE FROM calls WHERE tenant_id=${f.tenant}`;await sql`DELETE FROM audit_log WHERE tenant_id=${f.tenant}`;await sql`DELETE FROM tenants WHERE id=${f.tenant}`;await sql`DELETE FROM users WHERE id=${f.user}`;}await sql.close();});
 async function fixture(send?: (bot:string,text:string)=>Promise<void>) {
  const user=randomUUID(),tenant=randomUUID();fixtures.push({user,tenant});let now=Date.now();const sent:Array<[string,string]>=[];
  await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test.invalid`})`;await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
  const handler=createAgentsHandler({sql,sessionSecret:secret,keyring:{current:key},webOrigin:'https://web.test',clock:()=>now,sendChat:async(bot,text)=>{sent.push([bot,text]);await send?.(bot,text);}});
  const owner={cookie:`samo_session=${signSession({userId:user,tenantId:tenant,iat:now},secret)}`,origin:'https://web.test','content-type':'application/json'};
  async function makeCall(){const call=randomUUID();await sql`INSERT INTO calls(id,tenant_id,meeting_url,status,recall_bot_id) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL','server-selected-bot')`;return call;}
  const call=await makeCall();
  const request=(path:string,method='GET',input?:unknown,headers:Record<string,string>=owner)=>handler(new Request(`https://web.test/calls/${call}/${path}`,{method,headers:{...headers,...(input?{'content-type':'application/json'}:{})},body:input?JSON.stringify(input):undefined}));
  const mint=()=>request('agent-bindings','POST',{provider:'codex',native_session_id:'accept-native',label:'acceptance'});
  const res=await mint();expect(res.status).toBe(201);const b:any=await res.json();
  const agent={authorization:`Bearer ${b.credential}`,'x-samograph-binding':b.id,'x-samograph-provider':'codex','x-samograph-session':'accept-native'};
  const chat=(text='reply',id=randomUUID(),headers=agent)=>request('agent/chat','POST',{text,request_id:id},headers);
  return {user,tenant,call,b,agent,owner,request,mint,chat,makeCall,sent,handler,clock:()=>now,advance:(ms:number)=>{now+=ms;}};
 }
 test('owner grant and revoke audit identify the acting user without storing credential',async()=>{
  const f=await fixture();await f.request(`agent-bindings/${f.b.id}`,'DELETE');const rows=await sql`SELECT actor,action,payload_sha256 FROM audit_log WHERE call_id=${f.call} ORDER BY ts,id`;expect(rows.map((r:any)=>r.actor)).toEqual([`user:${f.user}`,`user:${f.user}`]);expect(rows.map((r:any)=>r.payload_sha256)).toEqual([sha256Hex(f.b.id),sha256Hex(f.b.id)]);expect(JSON.stringify(rows)).not.toContain(f.b.credential);
 });
 test('native session IDs fit HTTP headers while human labels permit Unicode',async()=>{
  const f=await fixture();await f.request(`agent-bindings/${f.b.id}`,'DELETE');
  for(const native_session_id of ['session-😀','session-é','session\ncontrol','session\u007fcontrol','', '   ', ' padded', 'padded ', ' padded ', 'a'.repeat(201)]) expect((await f.request('agent-bindings','POST',{provider:'codex',native_session_id,label:'人間 label'})).status).toBe(400);
  expect((await f.request('agent-bindings','POST',{provider:'codex',native_session_id:'native session ASCII',label:'人間 label'})).status).toBe(201);
 });
 test('uppercase UUID call routes mint a usable canonical grant',async()=>{
  const f=await fixture();await f.request(`agent-bindings/${f.b.id}`,'DELETE');const mint=await f.handler(new Request(`https://web.test/calls/${f.call.toUpperCase()}/agent-bindings`,{method:'POST',headers:f.owner,body:JSON.stringify({provider:'codex',native_session_id:'upper-route',label:'UUID case'})}));expect(mint.status).toBe(201);const binding:any=await mint.json();expect(binding.call_id).toBe(f.call);const verified=verifyTokenSignature(binding.credential,{current:key});expect(verified.ok?verified.payload.call_id:null).toBe(f.call);
  const context=await f.handler(new Request(`https://web.test/calls/${f.call.toUpperCase()}/agent/context`,{headers:{...f.agent,authorization:`Bearer ${binding.credential}`,'x-samograph-binding':binding.id.toUpperCase(),'x-samograph-session':'upper-route'}}));expect(context.status).toBe(200);const page:any=await context.json();expect(page.binding.call_id).toBe(f.call);expect(page.binding.id).toBe(binding.id);
 });
 test('concurrent mint cannot create two active bindings',async()=>{
  const f=await fixture();await f.request(`agent-bindings/${f.b.id}`,'DELETE');
  const results=await Promise.all([f.mint(),f.mint(),f.mint()]);expect(results.map(r=>r.status).sort()).toEqual([201,409,409]);
  expect((await sql`SELECT count(*)::int AS n FROM agent_bindings WHERE call_id=${f.call} AND revoked_at IS NULL`)[0].n).toBe(1);
 });
 test('shared durable context quota serializes parallel requests and recovers at boundary',async()=>{
  const f=await fixture();await sql`UPDATE agent_bindings SET context_count=59,context_window=${new Date(f.clock())} WHERE id=${f.b.id}`;
  const results=await Promise.all(Array.from({length:3},()=>f.request('agent/context','GET',undefined,f.agent)));expect(results.map(r=>r.status).sort()).toEqual([200,429,429]);expect(results.find(r=>r.status===429)!.headers.get('retry-after')).toBe('60');
  expect((await sql`SELECT context_count FROM agent_bindings WHERE id=${f.b.id}`)[0].context_count).toBe(60);
  f.advance(60000);expect((await f.request('agent/context','GET',undefined,f.agent)).status).toBe(200);
 });
 test('chat binding and tenant quotas are durable, rejected attempts never send',async()=>{
  const f=await fixture();for(let i=0;i<10;i++) expect((await f.chat(`reply ${i}`)).status).toBe(200);
  expect((await f.chat('over binding budget')).status).toBe(429);expect(f.sent.length).toBe(10);
  expect((await sql`SELECT action,payload_sha256 FROM audit_log WHERE call_id=${f.call} AND action='agent_chat_rejected'`).map((r:any)=>r.payload_sha256)).toEqual([sha256Hex('over binding budget')]);
  // Three other authorized per-call bindings share the same tenant budget.
  for(let i=0;i<2;i++){
   const call=await f.makeCall();const mint=await f.handler(new Request(`https://web.test/calls/${call}/agent-bindings`,{method:'POST',headers:f.owner,body:JSON.stringify({provider:'other',native_session_id:`tenant-native-${i}`})}));expect(mint.status).toBe(201);const b:any=await mint.json();
   for(let j=0;j<10;j++) await sql`INSERT INTO agent_chat_requests(binding_id,call_id,request_id,content_sha256,outcome,created_at) VALUES (${b.id},${call},${randomUUID()},${sha256Hex('seed')},'unknown',${new Date(f.clock())})`;
  }
  f.advance(60000);expect((await f.chat('new minute')).status).toBe(200);expect(f.sent.length).toBe(11);
  // Move old rows back inside the current window; binding budget is also full,
  // so exercise the tenant cap through a fresh call with an empty binding budget.
  await sql`UPDATE agent_chat_requests SET created_at=${new Date(f.clock())} WHERE call_id IN (SELECT id FROM calls WHERE tenant_id=${f.tenant})`;
  const call=await f.makeCall();const minted=await f.handler(new Request(`https://web.test/calls/${call}/agent-bindings`,{method:'POST',headers:f.owner,body:JSON.stringify({provider:'codex',native_session_id:'tenant-cap'})}));const b:any=await minted.json();
  const response=await f.handler(new Request(`https://web.test/calls/${call}/agent/chat`,{method:'POST',headers:{...f.agent,authorization:`Bearer ${b.credential}`,'x-samograph-binding':b.id,'x-samograph-session':'tenant-cap','content-type':'application/json'},body:JSON.stringify({text:'over tenant budget',request_id:randomUUID()})}));expect(response.status).toBe(429);expect(f.sent.length).toBe(11);
 });
 test('durable submitted reservation means unknown after restart, changed text conflicts',async()=>{
  const f=await fixture(),id=randomUUID(),text='possibly already sent';await sql`INSERT INTO agent_chat_requests(binding_id,call_id,request_id,content_sha256,outcome,created_at) VALUES (${f.b.id},${f.call},${id},${sha256Hex(text)},'submitted',${new Date(f.clock())})`;
  const response=await f.chat(text,id);expect(response.status).toBe(200);expect(await response.json()).toEqual({request_id:id,outcome:'unknown'});expect((await f.chat('changed',id)).status).toBe(409);expect(f.sent).toEqual([]);
 });
 test('expiry, every terminal status, deleted account and wrong scopes prevent dispatch',async()=>{
  const f=await fixture();
  for(const status of ['PENDING','JOINING','ENDED','BOT_REMOVED','COULD_NOT_JOIN','COULD_NOT_RECORD']){
   await sql`UPDATE calls SET status=${status} WHERE id=${f.call}`;expect((await f.chat()).status).toBe(403);expect((await f.request('agent/context','GET',undefined,f.agent)).status).toBe(403);
  }
  await sql`UPDATE calls SET status='IN_CALL' WHERE id=${f.call}`;
  for(const scopes of [['share'],['listen'],['act:frame']]){const token=await mintToken(sql,{callId:f.call,scopes,signingKey:key,ttlSeconds:3600,now:Math.floor(f.clock()/1000)});expect((await f.chat('wrong grant',randomUUID(),{...f.agent,authorization:`Bearer ${token.token}`})).status).toBe(403);}
  f.advance(3600000);expect((await f.chat()).status).toBe(403);f.advance(-3600000);
  await sql`INSERT INTO audit_log(tenant_id,actor,action) VALUES (${f.tenant},'fixture','account_deleted')`;
  expect((await f.chat()).status).toBe(403);expect((await f.request('agent/context','GET',undefined,f.agent)).status).toBe(403);expect((await f.mint()).status).toBe(401);expect(f.sent).toEqual([]);
 });
 test('input size, exact identity and unknown fields reject without side effects',async()=>{
  const f=await fixture();for(const text of ['', ' '.repeat(10),'a'.repeat(2001),'😀'.repeat(1001)]) expect((await f.chat(text)).status).toBe(400);
  expect((await f.chat('wrong provider',randomUUID(),{...f.agent,'x-samograph-provider':'other'})).status).toBe(403);
  expect((await f.request('agent/chat','POST',{text:'caller bot override',request_id:randomUUID(),bot_id:'untrusted'},f.agent)).status).toBe(400);
  expect((await f.request('agent-bindings','POST',{provider:'codex',native_session_id:'other',scopes:['act:leave']})).status).toBe(400);
  const huge=await f.handler(new Request(`https://web.test/calls/${f.call}/agent/chat`,{method:'POST',headers:{...f.agent,'content-type':'application/json'},body:JSON.stringify({text:'x'.repeat(13000),request_id:randomUUID()})}));expect(huge.status).toBe(413);expect(f.sent).toEqual([]);
 });
 test('RLS hides and denies changes to bindings, ledger and transcript from another tenant',async()=>{
  const f=await fixture(),other=await fixture();await f.chat('secret text');await sql`INSERT INTO transcripts(call_id,seq,ts,speaker,text) VALUES (${f.call},1,now(),'owner','private transcript')`;
  await sql.begin(async raw=>{const tx=raw as unknown as SQL;await tx.unsafe('SET LOCAL ROLE samograph_app');await tx`SELECT set_config('app.tenant_id',${other.tenant},true)`;
   expect(await tx`SELECT id FROM agent_bindings WHERE call_id=${f.call}`).toHaveLength(0);expect(await tx`SELECT request_id FROM agent_chat_requests WHERE call_id=${f.call}`).toHaveLength(0);expect(await tx`SELECT seq FROM transcripts WHERE call_id=${f.call}`).toHaveLength(0);
   expect(await tx`UPDATE agent_bindings SET label='foreign change' WHERE id=${f.b.id} RETURNING id`).toHaveLength(0);
  });
  await expect(sql.begin(async raw=>{const tx=raw as unknown as SQL;await tx.unsafe('SET LOCAL ROLE samograph_app');await tx`SELECT set_config('app.tenant_id',${other.tenant},true)`;await tx`INSERT INTO agent_chat_requests(binding_id,call_id,request_id,content_sha256,outcome,created_at) VALUES (${f.b.id},${f.call},${randomUUID()},${sha256Hex('bad')},'accepted',now())`;})).rejects.toThrow();
  const audit=await sql`SELECT actor,action,payload_sha256 FROM audit_log WHERE call_id=${f.call} ORDER BY ts,id`;expect(audit.some((r:any)=>r.action==='agent_chat_accepted'&&r.actor===`agent:${f.b.id}`&&r.payload_sha256===sha256Hex('secret text'))).toBe(true);expect(JSON.stringify(audit)).not.toContain('secret text');
 });
 test('revoke completes while an admitted upstream send is in flight and blocks later sends',async()=>{
  let admitted!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{admitted=resolve;});const pending=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(async()=>{admitted();await pending;});const sending=f.chat('admitted before revoke');await entered;
  try {expect((await f.request(`agent-bindings/${f.b.id}`,'DELETE')).status).toBe(204);expect((await f.chat('after revoke')).status).toBe(403);} finally {release();}
  expect((await sending).status).toBe(200);expect(f.sent).toEqual([['server-selected-bot','admitted before revoke']]);
 });
 test('actual call purge and account erasure remove binding and request personal data',async()=>{
  for(const account of [false,true]){
   const f=await fixture();await f.chat('to erase');
   if(account){const erase=createAccountHandler({sql,sessionSecret:secret,emailSender:new InMemoryEmailSender(),now:f.clock});expect((await erase(new Request('https://web.test/account',{method:'DELETE',headers:f.owner}))).status).toBe(200);}
   else await sql.begin(async raw=>{const tx=raw as unknown as SQL;await tx.unsafe('SET LOCAL ROLE samograph_app');await tx`SELECT set_config('app.tenant_id',${f.tenant},true)`;await purgeCallRows(tx,f.call);});
   expect(await sql`SELECT id FROM agent_bindings WHERE id=${f.b.id}`).toHaveLength(0);expect(await sql`SELECT request_id FROM agent_chat_requests WHERE binding_id=${f.b.id}`).toHaveLength(0);expect((await f.chat('after erase')).status).toBe(403);
  }
 });
});
