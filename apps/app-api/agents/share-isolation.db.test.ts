import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect } from '../../../packages/shared/db/client.ts';
import { migrate } from '../../../packages/shared/db/migrate.ts';
import { mintToken, mintShareToken, verifyToken } from '../../../packages/shared/tokens/store.ts';
import { createCallsHandler } from '../calls/http.ts';
import { signSession } from '../auth/session.ts';

const suite=process.env.DATABASE_URL?describe:describe.skip;
suite('share management isolates agent capabilities',()=>{
 let sql:ReturnType<typeof connect>;const users:string[]=[];
 const key={kid:'share-lane-old',secret:'fixture-only-old'},current={kid:'share-lane-new',secret:'fixture-only-new'},sessionSecret='fixture-share-lane-session';
 beforeAll(()=>{sql=connect();});
 afterAll(async()=>{for(const id of users)await sql`DELETE FROM users WHERE id=${id}`;await sql.close();});
 async function fixture(rotated=false){
  await migrate(sql);const user=randomUUID(),tenant=randomUUID(),call=randomUUID();users.push(user);
  await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@fixture.invalid`})`;
  await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
  await sql`INSERT INTO calls(id,tenant_id,meeting_url,status) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL')`;
  const keyring=rotated?{current,previous:key}:{current:key};
  const handler=createCallsHandler({sql,sessionSecret,keyring,enqueue:()=>{}});
  const cookie=`samo_session=${signSession({userId:user,tenantId:tenant,iat:Date.now()},sessionSecret)}`;
  const request=(suffix='',method='GET')=>handler(new Request(`https://fixture.test/calls/${call}/share${suffix}`,{method,headers:{cookie}}));
  const agent=await mintToken(sql,{callId:call,scopes:['listen','act:chat'],signingKey:key,ttlSeconds:3600});
  return {call,agent,keyring,request};
 }
 test('share lookup never redisplays an agent grant, and selects only a share',async()=>{
  const f=await fixture();expect((await f.request()).status).toBe(404);
  const share=await mintShareToken(sql,{callId:f.call,signingKey:key,ttlSeconds:1200});
  const response=await f.request();expect(response.status).toBe(200);
  const body:any=await response.json();expect(body.token_id).toBe(share.jti);
  expect((await verifyToken(sql,body.token,f.keyring,{requireScope:'share'})).ok).toBe(true);
 });
 test('call-wide share revoke and rotate leave agent token live',async()=>{
  const f=await fixture();await mintShareToken(sql,{callId:f.call,signingKey:key,ttlSeconds:1200});
  expect((await f.request('','DELETE')).status).toBe(204);
  expect((await verifyToken(sql,f.agent.token,f.keyring,{requireScope:'listen'})).ok).toBe(true);
  expect((await f.request('/rotate','POST')).status).toBe(200);
  expect((await verifyToken(sql,f.agent.token,f.keyring,{requireScope:'act:chat'})).ok).toBe(true);
 });
 test('specific share revoke cannot revoke an agent or another calls token',async()=>{
  const f=await fixture(),other=await fixture();
  const share=await mintShareToken(sql,{callId:other.call,signingKey:key,ttlSeconds:1200});
  expect((await f.request(`/${f.agent.jti}`,'DELETE')).status).toBe(204);
  expect((await verifyToken(sql,f.agent.token,f.keyring,{requireScope:'listen'})).ok).toBe(true);
  expect((await f.request(`/${share.jti}`,'DELETE')).status).toBe(204);
  expect((await verifyToken(sql,share.token,f.keyring,{requireScope:'share'})).ok).toBe(true);
 });
 test('retrieved previous-key share verifies during rotation overlap',async()=>{
  const f=await fixture(true);await sql`DELETE FROM tokens WHERE jti=${f.agent.jti}`;const share=await mintShareToken(sql,{callId:f.call,signingKey:key,ttlSeconds:1200});
  const response=await f.request();expect(response.status).toBe(200);
  const body:any=await response.json();expect(body.token_id).toBe(share.jti);
  expect((await verifyToken(sql,body.token,f.keyring,{requireScope:'share'})).ok).toBe(true);
 });
});
