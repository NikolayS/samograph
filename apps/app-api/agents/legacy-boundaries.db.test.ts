import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { mintToken, mintShareToken } from "../../../packages/shared/tokens/store.ts";
import { createCallsHandler } from "../calls/http.ts";
import { signSession } from "../auth/session.ts";
import { createTranscriptHandler, createTranscriptTextHandler } from "../../ws-hub/transcript-http.ts";
import { prepareStream } from "../../ws-hub/stream.ts";

const d=process.env.DATABASE_URL ? describe : describe.skip;
d("scoped agent credentials cannot open legacy unbounded read surfaces",()=>{
  let sql:ReturnType<typeof connect>;const user=randomUUID(),tenant=randomUUID(),call=randomUUID();
  const key={kid:"legacy-agent-test",secret:"fixture-only-legacy-key"};
  const sessionSecret="fixture-session-secret-legacy";
  const ownerCookie=`samo_session=${signSession({userId:user,tenantId:tenant,iat:Date.now()},sessionSecret)}`;
  const authDeps={keyring:{current:key},lookupSession:async(cookie:string)=>cookie==="owner"?{userId:user,tenantId:tenant}:null,lookupCallTenant:async(id:string)=>id===call?tenant:null};
  let calls:ReturnType<typeof createCallsHandler>;
  let transcript:ReturnType<typeof createTranscriptHandler>;
  let download:ReturnType<typeof createTranscriptTextHandler>;
  beforeAll(async()=>{
    sql=connect();
    calls=createCallsHandler({sql,sessionSecret,keyring:{current:key},enqueue:()=>{}});
    transcript=createTranscriptHandler({sql,authDeps});
    download=createTranscriptTextHandler({sql,authDeps});
    await migrate(sql);
    await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@fixture.invalid`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
    await sql`INSERT INTO calls(id,tenant_id,meeting_url,status) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL')`;
    await sql`INSERT INTO transcripts(call_id,seq,ts,speaker,text) VALUES (${call},1,now(),'Participant','old context')`;
  });
  afterAll(async()=>{await sql`DELETE FROM users WHERE id=${user}`;await sql.close();});
  test("agent grants stay out of each legacy Bearer/query lane; share remains usable",async()=>{
    for(const scopes of [["listen"],["act:chat"],["listen","act:chat"]]){
      const {token}=await mintToken(sql,{callId:call,scopes,signingKey:key,ttlSeconds:3600});
      for(const query of [false,true]){
        const req=(suffix:string)=>new Request(`https://fixture.test/calls/${call}${suffix}${query?`?token=${encodeURIComponent(token)}`:""}`,{headers:query?{}:{authorization:`Bearer ${token}`}});
        expect((await calls(req(""))).status).toBe(403);
        expect((await transcript(req("/transcript"))).status).toBe(403);
        expect((await download(req("/transcript.txt"))).status).toBe(403);
        const stream=await prepareStream(sql,req("/stream"),authDeps);
        expect(stream.ok).toBe(false);
        if(!stream.ok) expect(stream.response.status).toBe(403);
      }
    }
    const share=await mintShareToken(sql,{callId:call,signingKey:key,ttlSeconds:3600});
    const req=(suffix:string)=>new Request(`https://fixture.test/calls/${call}${suffix}`,{headers:{authorization:`Bearer ${share.token}`}});
    expect((await calls(req(""))).status).toBe(200);
    expect((await transcript(req("/transcript"))).status).toBe(200);
    expect((await download(req("/transcript.txt"))).status).toBe(200);
    expect((await prepareStream(sql,req("/stream"),authDeps)).ok).toBe(true);
    expect((await calls(new Request(`https://fixture.test/calls/${call}`,{headers:{cookie:ownerCookie}}))).status).toBe(200);
  });
});
