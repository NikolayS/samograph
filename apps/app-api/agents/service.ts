import type { SQL } from "bun";
import { authorizeCall, type AuthorizeDeps } from "../../../packages/shared/auth/gate.ts";
import { verifyTokenSignature, type Keyring } from "../../../packages/shared/tokens/signing.ts";
import { tenantActive, resolveOwnerSession } from "../auth/owner-session.ts";
import { sha256Hex } from "../../../packages/shared/crypto.ts";
export interface AgentConfig { sql: SQL; sessionSecret:string; keyring:Keyring; webOrigin:string; sendChat:(botId:string,text:string)=>Promise<void>; clock?:()=>number }
export class AgentError extends Error { constructor(public status:number, public code:string, message:string){super(message);} }
export const fail = (status:number,code:string,message:string):never => {throw new AgentError(status,code,message);};
export const uuid = (s:string|null):s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function sessionCookie(req:Request):string|null { return req.headers.get("cookie")?.split(";").map(s=>s.trim()).find(s=>s.startsWith("samo_session="))?.slice(13) ?? null; }
export async function audit(tx:SQL,tenant:string,call:string,binding:string,action:string,hash?:string) {
 await tx`INSERT INTO audit_log(tenant_id,call_id,actor,action,payload_sha256) VALUES (${tenant},${call},${`agent:${binding}`},${action},${hash ?? null})`;
}
export function gateDeps(config:AgentConfig):AuthorizeDeps { return {
 keyring:config.keyring, now:Math.floor((config.clock?.()??Date.now())/1000),
 lookupSession:async cookie=>{const session=await resolveOwnerSession(config.sql,config.sessionSecret,cookie,config.clock?.()??Date.now());return session.kind==="ok"?session.claims:null;},
 lookupCallTenant:async id=>{const rows=await config.sql`SELECT tenant_id FROM calls WHERE id=${id}`;const tenant=rows[0]?.tenant_id;return tenant && await tenantActive(config.sql,tenant)?tenant:null;}
}; }
export async function authorizeAgent(tx:SQL,config:AgentConfig,req:Request,callId:string,scope:"listen"|"act:chat") {
 const raw=req.headers.get("authorization");
 const token=raw?.match(/^Bearer ([A-Za-z0-9_.-]{1,8192})$/)?.[1];
 const bindingId=req.headers.get("x-samograph-binding");
 if(!token||!uuid(bindingId)) fail(403,"SAMO-AUTHZ-001","This agent grant cannot access the call.");
 const auth=await authorizeCall(tx,{callId,agentToken:token},gateDeps(config));
 if(!auth.authorized||!auth.scopes.includes(scope)) fail(403,"SAMO-AUTHZ-001","This agent grant cannot access the call.");
 const sig=verifyTokenSignature(token,config.keyring,{now:Math.floor((config.clock?.()??Date.now())/1000)});
 if(!sig.ok) fail(403,"SAMO-AUTHZ-001","This agent grant cannot access the call.");
 const rows=await tx`SELECT b.id,b.call_id,b.provider,b.native_session_id,b.min_seq::text,c.status,c.ingest_degraded,c.recall_bot_id
 FROM agent_bindings b JOIN tokens t ON t.id=b.token_id JOIN calls c ON c.id=b.call_id
 WHERE b.id=${bindingId} AND b.call_id=${callId} AND t.jti=${sig.payload.jti} AND b.revoked_at IS NULL
 AND t.revoked_at IS NULL AND t.expires_at>${new Date(config.clock?.()??Date.now())} AND c.status='IN_CALL'
 FOR SHARE OF b,c,t`;
 const b=rows[0];
 if(!b||b.provider!==req.headers.get("x-samograph-provider")||b.native_session_id!==req.headers.get("x-samograph-session")) fail(403,"SAMO-AUTHZ-001","This agent grant cannot access the call.");
 return {tenantId:auth.tenantId,binding:{...b,min_seq:Number(b.min_seq)}};
}
export async function chat(config:AgentConfig,req:Request,callId:string,text:string,requestId:string) {
 const contentHash=sha256Hex(text);const now=new Date(config.clock?.()??Date.now());
 const reserved=await config.sql.begin(async raw=>{
  const tx=raw as unknown as SQL;await tx.unsafe("SET LOCAL ROLE samograph_app");
  const auth=await authorizeAgent(tx,config,req,callId,"act:chat");const b=auth.binding;
  // Shared tenant lock serializes rate budget + dedup reservations across replicas.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-chat:${auth.tenantId}`},0))`;
  const prior=await tx`SELECT content_sha256,outcome FROM agent_chat_requests WHERE binding_id=${b.id} AND request_id=${requestId}`;
  if(prior.length) {
   if(prior[0].content_sha256!==contentHash) fail(409,"SAMO-AGENT-REQUEST","This request ID already names different text.");
   return {outcome:prior[0].outcome==="submitted"?"unknown":prior[0].outcome,dispatch:false,...auth};
  }
  const rates=await tx`SELECT count(*)::int AS tenant_count,count(*) FILTER (WHERE r.binding_id=${b.id})::int AS binding_count FROM agent_chat_requests r JOIN calls c ON c.id=r.call_id WHERE c.tenant_id=${auth.tenantId} AND r.created_at>${new Date(now.getTime()-60000)}`;
  if(rates[0].tenant_count>=30||rates[0].binding_count>=10) fail(429,"SAMO-RATE-001","Too many chat requests. Try again shortly.");
  if(!b.recall_bot_id) fail(409,"SAMO-AGENT-CALL","The call has no active bot.");
  await tx`INSERT INTO agent_chat_requests(binding_id,call_id,request_id,content_sha256,outcome,created_at) VALUES (${b.id},${callId},${requestId},${contentHash},'submitted',${now})`;
  await audit(tx,auth.tenantId,callId,b.id,"agent_chat_submitted",contentHash);
  await tx`UPDATE agent_bindings SET last_request_at=${now} WHERE id=${b.id}`;
  return {outcome:"submitted",dispatch:true,...auth};
 });
 if(!reserved.dispatch) return {request_id:requestId,outcome:reserved.outcome};
 // Reauthorize immediately before dispatch. Once admitted, revoke cannot retract a send.
 try {
  await config.sql.begin(async raw=>{const tx=raw as unknown as SQL;await tx.unsafe("SET LOCAL ROLE samograph_app");await authorizeAgent(tx,config,req,callId,"act:chat");});
 } catch(error) { await finish("rejected"); throw error; }
 let outcome="accepted";
 try { await config.sendChat(reserved.binding.recall_bot_id,text); } catch { outcome="unknown"; }
 await finish(outcome);
 return {request_id:requestId,outcome};
 async function finish(outcome:string) {
  await config.sql.begin(async raw=>{const tx=raw as unknown as SQL;await tx.unsafe("SET LOCAL ROLE samograph_app");await tx`SELECT set_config('app.tenant_id',${reserved.tenantId},true)`;
   // A concurrent call erasure may have cascaded the ledger; never recreate it.
   const updated=await tx`UPDATE agent_chat_requests SET outcome=${outcome} WHERE binding_id=${reserved.binding.id} AND request_id=${requestId} RETURNING request_id`;
   if(updated.length) await audit(tx,reserved.tenantId,callId,reserved.binding.id,`agent_chat_${outcome}`,contentHash);
  });
 }
}
