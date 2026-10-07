import { isRecallLive } from '../../bot-orchestrator/recallClient.ts';
import { liveRecallBotActions } from '../../bot-orchestrator/recallBotActions.ts';
import type { FetchFn } from '../../../src/recall.ts';
import type { AgentConfig } from './service.ts';

/** Entrypoints opt in explicitly. The factory remains independent of environment. */
export function hostedAgentChatFromEnv(
 env:Record<string,string|undefined>=process.env,
 fetchFn?:FetchFn,
 observeFake?:(botId:string,text:string)=>void,
):AgentConfig['sendChat']|undefined {
 if(env.SAMOGRAPH_HOSTED_AGENT_ENABLED!=='true') return undefined;
 if(isRecallLive(env)) {
  const actions=liveRecallBotActions({env,fetch:fetchFn});
  return (botId,text)=>actions.sendChat(botId,text);
 }
 // Network-free fake for local/preview composition. Fixtures can observe exact
 // server-selected destinations and text through the same injected port.
 return async(botId,text)=>{observeFake?.(botId,text);};
}
