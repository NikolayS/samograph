import type { ParsedArgs } from "../args.ts";
import { callIdFromStateFile, serve, type ServeOptions } from "../server.ts";

/**
 * Resolve serve tokens from flags with env-var fallback. join passes tokens
 * via the spawn env (SAMOGRAPH_*_TOKEN) so secrets never appear in argv/ps.
 */
export function resolveServeOptions(
  args: ParsedArgs,
  env: Record<string, string | undefined> = process.env,
): Pick<ServeOptions, "webhookToken" | "frameToken" | "presenceToken" | "presenceWriteToken"> {
  return {
    webhookToken: args.webhook_token || env.SAMOGRAPH_WEBHOOK_TOKEN || "",
    frameToken: args.frame_token || env.SAMOGRAPH_FRAME_TOKEN || "",
    presenceToken: args.presence_token || env.SAMOGRAPH_PRESENCE_TOKEN || "",
    presenceWriteToken: args.presence_write_token || env.SAMOGRAPH_PRESENCE_WRITE_TOKEN || "",
  };
}

export async function cmdServe(args: ParsedArgs): Promise<void> {
  const port = args.port || 8080;
  const transcriptPath = args.transcript_file!;
  serve(port, transcriptPath, {
    ...resolveServeOptions(args),
    currentCallId: () => callIdFromStateFile(args.call_id_file),
  });
  // Keep the process alive — Bun.serve does not block on its own.
  await new Promise<void>(() => {});
}
