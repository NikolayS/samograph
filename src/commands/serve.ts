import type { ParsedArgs } from "../args.ts";
import { serve } from "../server.ts";

export async function cmdServe(args: ParsedArgs): Promise<void> {
  const port = args.port || 8080;
  const transcriptPath = args.transcript_file!;
  serve(port, transcriptPath, args.webhook_token);
  // Keep the process alive — Bun.serve does not block on its own.
  await new Promise<void>(() => {});
}
