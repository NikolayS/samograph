import { test, expect } from 'bun:test';
import type { SQL } from 'bun';
import { createAppApi } from '../app.ts';
import { InMemoryEmailSender } from '../auth/index.ts';
import { hostedAgentChatFromEnv } from './runtime.ts';

test('hosted routes are absent by default and explicit composition reaches bearer handler',async()=>{
 const config={sql:{} as SQL,sessionSecret:'fixture-session',magicLinkKid:'fixture',magicLinkSecret:'fixture-link',tokenKeyring:{current:{kid:'fixture',secret:'fixture-token'}},emailSender:new InMemoryEmailSender(),webOrigin:'https://web.test',enqueue:()=>{}};
 const request=()=>new Request('https://web.test/calls/11111111-1111-1111-1111-111111111111/agent/context?after_seq=-1');
 expect((await createAppApi(config).fetch(request())).status).toBe(404);
 expect((await createAppApi({...config,hostedAgentChat:async()=>{}}).fetch(request())).status).toBe(400);
});
test('runtime opt in is exact and fake adapter records without external network',async()=>{
 for(const value of [undefined,'false','1','TRUE',' true ']) expect(hostedAgentChatFromEnv({SAMOGRAPH_HOSTED_AGENT_ENABLED:value})).toBeUndefined();
 const sent:Array<[string,string]>=[];
 const send=hostedAgentChatFromEnv({SAMOGRAPH_HOSTED_AGENT_ENABLED:'true'},undefined,(bot,text)=>{sent.push([bot,text]);});
 await send!('fake-bot','hello');expect(sent).toEqual([['fake-bot','hello']]);
});
test('runtime live opt in uses existing bounded Recall adapter',async()=>{
 const calls:Array<{url:string;init:RequestInit}>=[];
 const send=hostedAgentChatFromEnv({SAMOGRAPH_HOSTED_AGENT_ENABLED:'true',RECALL_LIVE:'1',RECALL_API_KEY:'fake-key'},async(url,init)=>{calls.push({url:String(url),init:init!});return new Response(null,{status:200});});
 await send!('server-bot','hello');expect(calls.length).toBe(1);expect(calls[0]!.url).toContain('/bot/server-bot/send_chat_message/');expect(calls[0]!.init.body).toBe(JSON.stringify({message:'hello'}));expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
});
