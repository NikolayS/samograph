import { join } from "node:path";
import { watch } from "../transcript.ts";
import { ExitError, samographDir } from "../config.ts";
import type { ParsedArgs } from "../args.ts";
import { RemoteAuthError, resolveRemoteToken, runRemoteWatch } from "../remoteWatch.ts";

export async function cmdWatch(args?: ParsedArgs): Promise<void> {
  if (!args?.remote || !args.call_id) {
    await watch();
    return;
  }
  // #307 prototype 1: poll the hosted site; no tunnel, outbound HTTPS only.
  let token: string;
  try {
    token = resolveRemoteToken({ tokenFile: args.token_file });
  } catch (e) {
    process.stderr.write(`samograph: error: ${(e as Error).message}\n`);
    throw new ExitError(2);
  }
  const transcriptFile =
    args.transcript_file ?? join(samographDir(), "remote", args.call_id, "transcript.txt");
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runRemoteWatch({
      baseUrl: args.remote,
      callId: args.call_id,
      token,
      transcriptFile,
      intervalMs: args.interval_ms,
      signal: ac.signal,
    });
  } catch (e) {
    if (e instanceof RemoteAuthError) {
      process.stderr.write(`samograph watch --remote: ${e.message}\n`);
      throw new ExitError(1);
    }
    throw e;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
