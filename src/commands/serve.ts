import type { ParsedArgs } from "../args.ts";
import {
  callIdFromStateFile,
  serve,
  startTranscriptWatchdog,
  startTunnelWatchdog,
  transcriptStatusFromBot,
  type ServeOptions,
} from "../server.ts";
import { makeRecallClient } from "../recall.ts";
import { makeAnamAvatarProvider } from "../avatar.ts";

/**
 * Resolve serve tokens from flags with env-var fallback. join passes tokens
 * via the spawn env (SAMOGRAPH_*_TOKEN) so secrets never appear in argv/ps.
 * publicBase is not a secret: join passes it via --public-base (env fallback:
 * SAMOGRAPH_PUBLIC_BASE); empty disables the mid-call tunnel watchdog.
 */
export function resolveServeOptions(
  args: ParsedArgs,
  env: Record<string, string | undefined> = process.env,
): Pick<
  ServeOptions,
  | "webhookToken"
  | "frameToken"
  | "presenceToken"
  | "presenceWriteToken"
  | "avatarPersonaId"
  | "avatarVoiceId"
> & {
  publicBase: string;
} {
  return {
    webhookToken: args.webhook_token || env.SAMOGRAPH_WEBHOOK_TOKEN || "",
    frameToken: args.frame_token || env.SAMOGRAPH_FRAME_TOKEN || "",
    presenceToken: args.presence_token || env.SAMOGRAPH_PRESENCE_TOKEN || "",
    presenceWriteToken: args.presence_write_token || env.SAMOGRAPH_PRESENCE_WRITE_TOKEN || "",
    // Persona id is not a secret (the API key is); it selects which published
    // Anam persona to mint a session for. The key is read at mint time from
    // ANAM_API_KEY via makeAnamAvatarProvider. Both arrive via the inherited
    // env when join spawns _serve (spawnDetached merges process.env).
    avatarPersonaId: args.anam_persona || env.SAMOGRAPH_ANAM_PERSONA_ID || "",
    avatarVoiceId: args.anam_voice || env.SAMOGRAPH_ANAM_VOICE_ID || "",
    publicBase: args.public_base || env.SAMOGRAPH_PUBLIC_BASE || "",
  };
}

export async function cmdServe(args: ParsedArgs): Promise<void> {
  const port = args.port || 8080;
  const transcriptPath = args.transcript_file!;
  const { publicBase, ...tokens } = resolveServeOptions(args);
  serve(port, transcriptPath, {
    ...tokens,
    // Always pass a provider; the /avatar/session endpoint reports
    // { enabled: false } when avatarPersonaId is empty or minting fails
    // (e.g. ANAM_API_KEY unset), so the page falls back to the static avatar.
    avatarProvider: makeAnamAvatarProvider(),
    currentCallId: () => callIdFromStateFile(args.call_id_file),
  });
  // Mid-call tunnel watchdog: probes the public URL through the tunnel back
  // to this server and writes SAMOGRAPH-WARNING lines into the transcript
  // (surfaced live by `samograph watch`) when the tunnel stops relaying.
  startTunnelWatchdog({ publicBase, transcriptPath });
  // Mid-call transcript-stream watchdog: polls Recall's recording transcript
  // status and writes a SAMOGRAPH-WARNING line (surfaced live by `samograph
  // watch`) the moment the transcription provider connection fails — otherwise
  // a healthy tunnel delivering frames but no transcript looks exactly like
  // "nobody has spoken yet" and the bot sits silently deaf.
  const recall = makeRecallClient();
  startTranscriptWatchdog({
    transcriptPath,
    fetchStatus: async () => {
      const botId = callIdFromStateFile(args.call_id_file);
      if (!botId) return null;
      return transcriptStatusFromBot(await recall.getBot(botId));
    },
  });
  // Keep the process alive — Bun.serve does not block on its own.
  await new Promise<void>(() => {});
}
