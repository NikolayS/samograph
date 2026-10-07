import { describe,test,expect,beforeAll,afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { connect } from '../../../packages/shared/db/client.ts';
import { migrate } from '../../../packages/shared/db/migrate.ts';
import { mintShareToken } from '../../../packages/shared/tokens/store.ts';
import { signSession } from '../auth/session.ts';
import { createAgentsHandler } from '../agents/http.ts';
import { createCallsHandler } from './http.ts';
import { purgeCallRows } from './erase.ts';

type Outcome<T>={ok:true;value:T}|{ok:false;code:string;message:string};
const settle=<T>(promise:Promise<T>):Promise<Outcome<T>>=>promise.then(value=>({ok:true,value}),error=>({ok:false,code:error.errno??error.code??'',message:error.message}));
const suite=process.env.DATABASE_URL?describe:describe.skip;
suite('call-before-child locks for audited share mutations and chat completion',()=>{
 const sql=connect(),key={kid:'audit-lock',secret:'audit-lock-fixture'},secret='audit-lock-session';const fixtures:Array<{user:string;tenant:string}>=[];
 beforeAll(async()=>{await migrate(sql);});
 afterAll(async()=>{for(const f of fixtures){await sql`DELETE FROM calls WHERE tenant_id=${f.tenant}`;await sql`DELETE FROM audit_log WHERE tenant_id=${f.tenant}`;await sql`DELETE FROM tenants WHERE id=${f.tenant}`;await sql`DELETE FROM users WHERE id=${f.user}`;}await sql.close();});
 async function fixture(){
  const user=randomUUID(),tenant=randomUUID(),call=randomUUID(),now=Date.now();fixtures.push({user,tenant});
  await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test.invalid`})`;await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
  await sql`INSERT INTO calls(id,tenant_id,meeting_url,status,recall_bot_id) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL','fake-bot')`;
  const owner={cookie:`samo_session=${signSession({userId:user,tenantId:tenant,iat:now},secret)}`,origin:'https://web.test'};
  const calls=createCallsHandler({sql,sessionSecret:secret,keyring:{current:key},enqueue:()=>{}});
  const request=(path:string,method:string)=>calls(new Request(`https://web.test/calls/${call}/${path}`,{method,headers:owner}));
  return {user,tenant,call,owner,request};
 }
 async function eraseRace(f:Awaited<ReturnType<typeof fixture>>,start:()=>Promise<Outcome<Response>>){
  let operation:Promise<Outcome<Response>>|undefined,blockedQuery='';
  const erasure=await settle(sql.begin(async raw=>{
   const tx=raw as unknown as SQL;await tx.unsafe('SET LOCAL ROLE samograph_app');await tx`SELECT set_config('app.tenant_id',${f.tenant},true)`;
   await tx`SELECT id FROM calls WHERE id=${f.call} FOR UPDATE`;const self=await tx`SELECT pg_backend_pid() AS pid`;const pid=self[0].pid;
   operation=start();
   // Real handler has reached a PostgreSQL wait on this exact purge transaction.
   for(let attempt=0;attempt<200;attempt++){
    const blocked=await sql`SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`;
    if(blocked.length){blockedQuery=blocked[0].query;break;}await Bun.sleep(10);
   }
   if(!blockedQuery) throw new Error('Actual request did not reach purge lock barrier');
   await purgeCallRows(tx,f.call);
  }));
  const result=await operation;
  expect({erasure:erasure.ok,result:result?.ok,...(!erasure.ok?{error:erasure}:{}),...(result&&!result.ok?{requestError:result}:{})}).toEqual({erasure:true,result:true});
  expect(blockedQuery).toMatch(/SELECT id FROM calls[\s\S]*FOR UPDATE/i);
  expect(await sql`SELECT id FROM calls WHERE id=${f.call}`).toHaveLength(0);
  return result&&result.ok?result.value:undefined;
 }
 test('actual admitted chat completion cannot hold ledger while waiting on audit call FK',async()=>{
  const f=await fixture();let entered!:()=>void,release!:()=>void;const admitted=new Promise<void>(resolve=>{entered=resolve;});const upstream=new Promise<void>(resolve=>{release=resolve;});
  const agents=createAgentsHandler({sql,sessionSecret:secret,keyring:{current:key},webOrigin:'https://web.test',sendChat:async()=>{entered();await upstream;}});
  const mint=await agents(new Request(`https://web.test/calls/${f.call}/agent-bindings`,{method:'POST',headers:{...f.owner,'content-type':'application/json'},body:JSON.stringify({provider:'codex',native_session_id:'audit-lock-native',label:'Fixture'})}));expect(mint.status).toBe(201);const binding:any=await mint.json(),requestId=randomUUID();
  const sending=settle(agents(new Request(`https://web.test/calls/${f.call}/agent/chat`,{method:'POST',headers:{authorization:`Bearer ${binding.credential}`,'x-samograph-binding':binding.id,'x-samograph-provider':'codex','x-samograph-session':'audit-lock-native','content-type':'application/json'},body:JSON.stringify({text:'deliberate',request_id:requestId})})));
  await admitted;let response:Response|undefined;try{response=await eraseRace(f,()=>{release();return sending;});}finally{release();await sending;}
  expect(response?.status).toBe(200);expect(await response?.json()).toEqual({request_id:requestId,outcome:'accepted'});
  expect(await sql`SELECT request_id FROM agent_chat_requests WHERE binding_id=${binding.id}`).toHaveLength(0);expect(await sql`SELECT action FROM audit_log WHERE call_id=${f.call}`).toHaveLength(0);
 });
 for(const mode of ['bulk revoke','rotate','individual revoke','mint'] as const) test(`actual share ${mode} waits on call before touching child or audit rows`,async()=>{
  const f=await fixture();const token=await mintShareToken(sql,{callId:f.call,signingKey:key,ttlSeconds:3600});
  const path=mode==='rotate'?'share/rotate':mode==='individual revoke'?`share/${token.jti}`:'share';const method=mode==='rotate'||mode==='mint'?'POST':'DELETE';
  const response=await eraseRace(f,()=>settle(f.request(path,method)));expect(response?.status).toBe(403);
  expect(await sql`SELECT id FROM tokens WHERE call_id=${f.call}`).toHaveLength(0);expect(await sql`SELECT action FROM audit_log WHERE call_id=${f.call}`).toHaveLength(0);
 });
});
