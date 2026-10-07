import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect } from '../../../packages/shared/db/client.ts';
import { migrate } from '../../../packages/shared/db/migrate.ts';
import { signSession } from '../auth/session.ts';
import { createAgentsHandler } from './http.ts';
import { CONTEXT_BYTES } from './context.ts';

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite('agent context projection and grant floor', () => {
 const sql=connect(); const user=randomUUID(),tenant=randomUUID();const calls:string[]=[];
 const now=Date.now(),secret='bounds-session',key={kid:'bounds',secret:'bounds-test-key'};
 const owner={cookie:`samo_session=${signSession({userId:user,tenantId:tenant,iat:now},secret)}`,origin:'https://web.test','content-type':'application/json'};
 const handler=createAgentsHandler({sql,sessionSecret:secret,keyring:{current:key},webOrigin:'https://web.test',clock:()=>now,sendChat:async()=>{}});
 beforeAll(async()=>{await migrate(sql);await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test.invalid`})`;await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;});
 afterAll(async()=>{for(const id of calls) await sql`DELETE FROM calls WHERE id=${id}`;await sql`DELETE FROM tenants WHERE id=${tenant}`;await sql`DELETE FROM users WHERE id=${user}`;await sql.close();});
 async function fixture(rows:Array<{seq:number;text:string;age?:number;speaker?:string}>) {
  const call=randomUUID();calls.push(call);await sql`INSERT INTO calls(id,tenant_id,meeting_url,status,recall_bot_id,ingest_degraded) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL','fake-bot',true)`;
  for(const r of rows) await sql`INSERT INTO transcripts(call_id,seq,ts,speaker,text,kind) VALUES (${call},${r.seq},${new Date(now-(r.age??1000))},${r.speaker??'Speaker'},${r.text},'speech')`;
  const mint=await handler(new Request(`https://web.test/calls/${call}/agent-bindings`,{method:'POST',headers:owner,body:JSON.stringify({provider:'codex',native_session_id:'bounds-native',label:'bounds'})}));expect(mint.status).toBe(201);const b:any=await mint.json();
  const headers={authorization:`Bearer ${b.credential}`,'x-samograph-binding':b.id,'x-samograph-provider':'codex','x-samograph-session':'bounds-native'};
  return {call,b,get:(query='')=>handler(new Request(`https://web.test/calls/${call}/agent/context${query}`,{headers}))};
 }
 test('recent last 50 rows respect gaps and the five minute floor',async()=>{
  const f=await fixture([{seq:1,text:'old',age:300001},...Array.from({length:60},(_,i)=>({seq:(i+1)*10,text:`row ${i+1}`}))]);
  const page:any=await (await f.get()).json();expect(page.lines.map((r:any)=>r.seq)).toEqual(Array.from({length:50},(_,i)=>(i+11)*10));expect(page.next_seq).toBe(600);
  expect((await f.get('?after_seq=99')).status).toBe(400);
 });
 test('out-of-order old timestamps cannot widen the five-minute grant window',async()=>{
  const f=await fixture([{seq:1,text:'recent'},{seq:2,text:'old later sequence',age:300001},{seq:3,text:'newest'}]);const page:any=await (await f.get()).json();expect(page.lines.map((r:any)=>r.seq)).toEqual([3]);
 });
 test('escaped JSON oversize is explicitly omitted and advances without stalling',async()=>{
  const f=await fixture([{seq:1,text:'\u0001'.repeat(7000)},{seq:2,text:'after oversized'}]);
  const res=await f.get();const text=await res.text();expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CONTEXT_BYTES);const page=JSON.parse(text);
  expect(page.omitted).toEqual([{seq:1,reason:'oversized'}]);expect(page.lines.map((r:any)=>r.seq)).toEqual([2]);expect(page.next_seq).toBe(2);expect(page.truncated).toBe(true);
 });
 test('page byte budget resumes at exactly last disclosed row, with SQL-size omissions',async()=>{
  const f=await fixture([{seq:1,text:'x'.repeat(8193)},...Array.from({length:10},(_,i)=>({seq:i+2,text:'é'.repeat(4000)}))]);
  const firstRes=await f.get();const raw=await firstRes.text();expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(CONTEXT_BYTES);const first=JSON.parse(raw);
  expect(first.omitted).toEqual([{seq:1,reason:'oversized'}]);expect(first.lines.map((r:any)=>r.seq)).toEqual([2,3,4,5]);expect(first.next_seq).toBe(5);expect(first.has_more).toBe(true);
  const second:any=await (await f.get('?after_seq=5')).json();expect(second.lines.map((r:any)=>r.seq)).toEqual([6,7,8,9]);expect(second.next_seq).toBe(9);
 });
 test('quiet degraded calls stay active and invalid cursors fail strictly',async()=>{
  const f=await fixture([]);const page:any=await (await f.get()).json();expect(page.lines).toEqual([]);expect(page.next_seq).toBe(0);expect(page.status).toBe('IN_CALL');expect(page.ingest_degraded).toBe(true);
  for(const query of ['-1','01','1.5','1e2','9007199254740992','','1&after_seq=2']) expect((await f.get(`?after_seq=${query}`)).status).toBe(400);
 });
});
