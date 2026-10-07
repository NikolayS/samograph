import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect } from '../../../packages/shared/db/client.ts';
import { migrate } from '../../../packages/shared/db/migrate.ts';
import { createCallsHandler } from './http.ts';
import { signSession } from '../auth/session.ts';

const suite=process.env.DATABASE_URL?describe:describe.skip;
suite('concurrent per-call erasure',()=>{
 test('two admitted deletes serialize before audit FK locks and return idempotently',async()=>{
  const sql=connect(),user=randomUUID(),tenant=randomUUID(),call=randomUUID(),secret='fixture-delete-session';
  let arrived=0,release!:()=>void;const both=new Promise<void>(resolve=>{release=resolve;});
  const handler=createCallsHandler({sql,sessionSecret:secret,enqueue:()=>{},recall:{
   leave:async()=>{},deleteRecording:async()=>{if(++arrived===2)release();await both;},
  }});
  try{
   await migrate(sql);await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@fixture.invalid`})`;
   await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
   await sql`INSERT INTO calls(id,tenant_id,meeting_url,status,recall_bot_id) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL','fixture-delete-bot')`;
   const cookie=`samo_session=${signSession({userId:user,tenantId:tenant,iat:Date.now()},secret)}`;
   const run=()=>handler(new Request(`https://fixture.test/calls/${call}`,{method:'DELETE',headers:{cookie}})).then(r=>r.status,()=>500);
   expect(await Promise.all([run(),run()])).toEqual([204,204]);
   expect((await sql`SELECT count(*)::int AS n FROM deleted_calls WHERE call_id=${call}`)[0].n).toBe(1);
   expect(await sql`SELECT id FROM calls WHERE id=${call}`).toHaveLength(0);
  }finally{await sql`DELETE FROM calls WHERE id=${call}`;await sql`DELETE FROM audit_log WHERE tenant_id=${tenant}`;await sql`DELETE FROM deleted_calls WHERE call_id=${call}`;await sql`DELETE FROM tenants WHERE id=${tenant}`;await sql`DELETE FROM users WHERE id=${user}`;await sql.close();}
 });
});
