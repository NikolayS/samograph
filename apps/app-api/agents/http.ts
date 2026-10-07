import { sha256Hex } from "../../../packages/shared/crypto.ts";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { authorizeCall } from "../../../packages/shared/auth/gate.ts";
import { mintToken } from "../../../packages/shared/tokens/store.ts";
import { resolveOwnerSession, sessionInvalidResponse } from "../auth/owner-session.ts";
import { readContext } from "./context.ts";
import { AgentError, audit, authorizeAgent, chat, fail, gateDeps, sessionCookie, uuid, type AgentConfig } from "./service.ts";

const SCOPES = ["listen", "act:chat"];
const json = (value: unknown, status = 200) => Response.json(value, {status, headers:{"cache-control":"no-store"}});
async function body(req: Request): Promise<Record<string, unknown>> {
 if(req.headers.get("content-type")?.split(";")[0].trim()!=="application/json") fail(400,"SAMO-AGENT-INPUT","Send an explicit JSON request.");
 const reader=req.body?.getReader(); if(!reader) fail(400,"SAMO-AGENT-INPUT","A JSON body is required.");
 const chunks:Uint8Array[]=[];let length=0;
 while(true){const item=await reader.read();if(item.done) break;length+=item.value.byteLength;if(length>12*1024){await reader.cancel();fail(413,"SAMO-AGENT-INPUT","The request is too large.");}chunks.push(item.value);}
 try {const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!value||Array.isArray(value)||typeof value!=="object") throw new Error();return value;}catch{fail(400,"SAMO-AGENT-INPUT","Send a JSON object.");}
}
function metadata(row: any) {return {id:row.id,call_id:row.call_id,provider:row.provider,native_session_id:row.native_session_id,label:row.label,scopes:SCOPES,created_at:new Date(row.created_at).toISOString(),expires_at:new Date(row.expires_at).toISOString(),revoked_at:row.revoked_at?new Date(row.revoked_at).toISOString():null,last_request_at:row.last_request_at?new Date(row.last_request_at).toISOString():null};}
const printable=(value:unknown,max:number,min=0):value is string=>typeof value==="string"&&value.length>=min&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const nativeSession=(value:unknown):value is string=>typeof value==="string"&&value.length<=200&&!!value.trim()&&/^[\x20-\x7e]+$/.test(value);
export function createAgentsHandler(config:AgentConfig):(req:Request)=>Promise<Response> {
 return async req=>{try {
  const url=new URL(req.url);const match=url.pathname.match(/^\/calls\/([^/]+)\/(agent-bindings(?:\/([^/]+))?|agent\/(context|chat))$/);
  if(!match) return new Response("not found",{status:404});
  const callId=match[1]!;if(!uuid(callId)) fail(400,"SAMO-AGENT-INPUT","Invalid call ID.");
  const now=config.clock?.()??Date.now();
  if(match[2]!.startsWith("agent-bindings")) {
   const owner=await resolveOwnerSession(config.sql,config.sessionSecret,sessionCookie(req),now);
   if(owner.kind==="stale") return sessionInvalidResponse();
   if(owner.kind!=="ok") fail(401,"SAMO-AUTH-005","Please sign in.");
   if(!["GET","POST","DELETE"].includes(req.method)) return new Response(null,{status:405});
   if(req.method!=="GET"&&req.headers.get("origin")!==new URL(config.webOrigin).origin) fail(403,"SAMO-AUTHZ-001","The request origin is not permitted.");
   const input=req.method==="POST"?await body(req):undefined;
   return await config.sql.begin(async raw=>{
    const tx=raw as unknown as SQL;await tx.unsafe("SET LOCAL ROLE samograph_app");
    const auth=await authorizeCall(tx,{callId,sessionCookie:sessionCookie(req)},gateDeps(config));
    if(!auth.authorized) fail(403,"SAMO-AUTHZ-001","You don't have access to this call.");
    // One lock order for owner and agent mutations: call, binding, token.
    const calls=await tx`SELECT status FROM calls WHERE id=${callId} FOR UPDATE`;
    if(req.method==="GET"&&!match[3]) {const rows=await tx`SELECT b.*,t.expires_at FROM agent_bindings b JOIN tokens t ON t.id=b.token_id WHERE b.call_id=${callId} ORDER BY b.created_at DESC LIMIT 100`;return json({bindings:rows.map(metadata)});}
    if(req.method==="POST"&&!match[3]) {
     if(calls[0]?.status!=="IN_CALL") fail(409,"SAMO-AGENT-CALL","Connect an agent during an active call.");
     if(!input||!["codex","claude-code","other"].includes(String(input.provider))||!nativeSession(input.native_session_id)||!printable(input.label??"",80)||Object.keys(input).some(k=>!["provider","native_session_id","label"].includes(k))) fail(400,"SAMO-AGENT-INPUT","Choose a provider and exact session identity.");
     const active=await tx`SELECT id FROM agent_bindings WHERE call_id=${callId} AND revoked_at IS NULL`;
     if(active.length) fail(409,"SAMO-AGENT-CONFLICT","Revoke the existing binding before connecting another session.");
     const floors=await tx`SELECT COALESCE(max(seq),0)::text AS last_seq FROM transcripts WHERE call_id=${callId}`;
     const last=Number(floors[0].last_seq);
     const recent=await tx`SELECT min(seq) FILTER (WHERE ts>=${new Date(now-300000)})::text AS first_seq, max(seq) FILTER (WHERE ts<${new Date(now-300000)})::text AS old_seq FROM (SELECT seq,ts FROM transcripts WHERE call_id=${callId} ORDER BY seq DESC LIMIT 50) recent`;
     // A seq floor cannot punch holes. Narrow it past any out-of-order old
     // timestamp so no historical row outside the time window is exposed.
     const floor=Math.max(recent[0].first_seq==null?last+1:Number(recent[0].first_seq),Number(recent[0].old_seq??0)+1);
     const token=await mintToken(tx,{callId,scopes:SCOPES,signingKey:config.keyring.current,ttlSeconds:3600,now:Math.floor(now/1000)});
     const tokenRows=await tx`SELECT id,expires_at FROM tokens WHERE jti=${token.jti}`;const id=randomUUID();
     const rows=await tx`INSERT INTO agent_bindings(id,call_id,token_id,provider,native_session_id,label,min_seq,created_at) VALUES (${id},${callId},${tokenRows[0].id},${input.provider as string},${input.native_session_id},${input.label??""},${floor},${new Date(now)}) RETURNING *`;
     await audit(tx,auth.tenantId,callId,id,"agent_binding_minted",sha256Hex(id),`user:${owner.claims.userId}`);
     return json({...metadata({...rows[0],expires_at:tokenRows[0].expires_at}),credential:token.token},201);
    }
    if(req.method==="DELETE"&&uuid(match[3]??null)) {
     const rows=await tx`SELECT id,token_id,revoked_at FROM agent_bindings WHERE id=${match[3]} AND call_id=${callId} FOR UPDATE`;
     if(!rows.length) fail(403,"SAMO-AUTHZ-001","You don't have access to this binding.");
     if(!rows[0].revoked_at){await tx`UPDATE agent_bindings SET revoked_at=${new Date(now)} WHERE id=${rows[0].id}`;await tx`UPDATE tokens SET revoked_at=${new Date(now)} WHERE id=${rows[0].token_id}`;await audit(tx,auth.tenantId,callId,rows[0].id,"agent_binding_revoked",sha256Hex(rows[0].id),`user:${owner.claims.userId}`);}
     return new Response(null,{status:204,headers:{"cache-control":"no-store"}});
    }
    return new Response("not found",{status:404});
   });
  }
  if(match[4]==="context"&&req.method==="GET") {
   const cursors=url.searchParams.getAll("after_seq");const value=cursors[0];
   if(cursors.length>1||(value!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value))))) fail(400,"SAMO-AGENT-CURSOR","Use a valid transcript cursor.");
   return await config.sql.begin(async raw=>{const tx=raw as unknown as SQL;await tx.unsafe("SET LOCAL ROLE samograph_app");const auth=await authorizeAgent(tx,config,req,callId,"listen");const b=auth.binding;
    if(value!==undefined&&Number(value)<b.min_seq-1) fail(400,"SAMO-AGENT-CURSOR","The cursor predates this grant.");
    const rate=await tx`UPDATE agent_bindings SET context_count=CASE WHEN context_window IS NULL OR context_window<=${new Date(now-60000)} THEN 1 ELSE context_count+1 END,context_window=CASE WHEN context_window IS NULL OR context_window<=${new Date(now-60000)} THEN ${new Date(now)} ELSE context_window END,last_request_at=${new Date(now)} WHERE id=${b.id} RETURNING context_count`;
    if(rate[0].context_count>60) fail(429,"SAMO-RATE-001","Too many context requests. Try again shortly.");
    return json(await readContext(tx,b,{status:b.status,ingest_degraded:b.ingest_degraded},value===undefined?undefined:Number(value)));
   });
  }
  if(match[4]==="chat"&&req.method==="POST") {const input=await body(req);if(typeof input.text!=="string"||!input.text.trim()||input.text.length>2000||Buffer.byteLength(input.text,"utf8")>8192||!uuid(typeof input.request_id==="string"?input.request_id:null)||Object.keys(input).some(k=>!["text","request_id"].includes(k))) fail(400,"SAMO-AGENT-INPUT","Provide chat text and a request UUID.");return json(await chat(config,req,callId,input.text,input.request_id as string));}
  return new Response(null,{status:405});
 } catch(error) {if(error instanceof AgentError) {const response=json({code:error.code,message:error.message,retryable:error.status===429},error.status);if(error.status===429) response.headers.set("retry-after","60");return response;}return json({code:"SAMO-AGENT-500",message:"The agent request could not be completed.",retryable:false},500);}};
}
