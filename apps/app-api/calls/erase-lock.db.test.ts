import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { connect } from '../../../packages/shared/db/client.ts';
import { migrate } from '../../../packages/shared/db/migrate.ts';
import { mintToken } from '../../../packages/shared/tokens/store.ts';
import { purgeCallRows } from './erase.ts';

const suite=process.env.DATABASE_URL?describe:describe.skip;
suite('call erasure shares the agent call-before-binding lock order',()=>{
 const sql=connect(),user=randomUUID(),tenant=randomUUID(),call=randomUUID(),binding=randomUUID();
 beforeAll(async()=>{
  await migrate(sql);await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test.invalid`})`;await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
  await sql`INSERT INTO calls(id,tenant_id,meeting_url,status,recall_bot_id) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL','fake-bot')`;
  const token=await mintToken(sql,{callId:call,scopes:['listen','act:chat'],signingKey:{kid:'lock-fixture',secret:'lock-fixture'},ttlSeconds:3600});const rows=await sql`SELECT id FROM tokens WHERE jti=${token.jti}`;
  await sql`INSERT INTO agent_bindings(id,call_id,token_id,provider,native_session_id,label,min_seq,created_at) VALUES (${binding},${call},${rows[0].id},'codex','lock-session','Lock fixture',0,now())`;
 });
 afterAll(async()=>{await sql`DELETE FROM calls WHERE id=${call}`;await sql`DELETE FROM tenants WHERE id=${tenant}`;await sql`DELETE FROM users WHERE id=${user}`;await sql.close();});
 test('agent holding call can still lock binding while erasure waits, and both transactions complete',async()=>{
  type Outcome={ok:true}|{ok:false;code:string;message:string};
  const outcome=(promise:Promise<unknown>):Promise<Outcome>=>promise.then(()=>({ok:true}),error=>({ok:false,code:error.errno??error.code??String(error),message:error.message}));
  let erasing:Promise<Outcome>|undefined;let blockedQuery='';
  const holding=outcome(sql.begin(async raw=>{
   const tx=raw as unknown as SQL;await tx.unsafe('SET LOCAL ROLE samograph_app');await tx`SELECT set_config('app.tenant_id',${tenant},true)`;
   // Barrier 1: an authorized agent owns the call row before touching binding.
   await tx`SELECT id FROM calls WHERE id=${call} FOR UPDATE`;
   let identify!:(pid:number)=>void;const pidReady=new Promise<number>(resolve=>{identify=resolve;});
   erasing=outcome(sql.begin(async eraseRaw=>{
    const eraseTx=eraseRaw as unknown as SQL;await eraseTx.unsafe('SET LOCAL ROLE samograph_app');await eraseTx`SELECT set_config('app.tenant_id',${tenant},true)`;const pid=await eraseTx`SELECT pg_backend_pid() AS pid`;identify(pid[0].pid);
    await purgeCallRows(eraseTx,call);
   }));
   const pid=await pidReady;
   // Barrier 2: erasure has reached a real PostgreSQL lock wait. Before the fix
   // it owns token/binding locks and waits on call, creating a cycle below.
   for(let attempt=0;attempt<200;attempt++){
    const activity=await sql`SELECT query,wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
    if(activity[0]?.wait_event_type==='Lock'){blockedQuery=activity[0].query;break;}
    await Bun.sleep(10);
   }
   if(!blockedQuery) throw new Error('Erasure did not reach the lock barrier');
   // Fixed erasure waits on call before any child lock. This can finish safely.
   await tx`SELECT id FROM agent_bindings WHERE id=${binding} FOR UPDATE`;
  }));
  const held=await holding;const erased=await erasing;
  expect({holding:held,erasing:erased}).toEqual({holding:{ok:true},erasing:{ok:true}});
  expect(blockedQuery).toMatch(/SELECT id FROM calls[\s\S]*FOR UPDATE/i);
  expect(await sql`SELECT id FROM calls WHERE id=${call}`).toHaveLength(0);
  expect(await sql`SELECT id FROM agent_bindings WHERE id=${binding}`).toHaveLength(0);
 });
});
