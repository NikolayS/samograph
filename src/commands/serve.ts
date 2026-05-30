import type { ParsedArgs } from "../args.ts";
import { callIdFromStateFile, serve } from "../server.ts";

export async function cmdServe(args: ParsedArgs): Promise<void> {
  const port = args.port || 8080;
  const transcriptPath = args.transcript_file!;
  serve(port, transcriptPath, {
    webhookToken: args.webhook_token,
    frameToken: args.frame_token,
    currentCallId: () => callIdFromStateFile(args.call_id_file),
  });
  // Keep the process alive — Bun.serve does not block on its own.
  await new Promise<void>(() => {});
}
