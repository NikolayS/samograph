import { join } from "node:path";
import { watch } from "../transcript.ts";
import type { ParsedArgs } from "../args.ts";
import { ExitError, samographDir } from "../config.ts";
import { watchRemoteLongPoll, TOKEN_ENV } from "../remoteWatch.ts";

export async function cmdWatch(args?: ParsedArgs): Promise<void> {
  if (!args?.remote) {
    await watch();
    return;
  }
  // #307 prototype 2/3: pull from the hosted site — no tunnel, outbound only.
  const token = process.env[TOKEN_ENV];
  if (!token) {
    process.stderr.write(`watch --remote needs a per-call share token in ${TOKEN_ENV}.\n`);
    throw new ExitError(2);
  }
  const callId = args.call_id!;
  const file =
    args.transcript_file ??
    join(samographDir(), `remote-${callId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  const res = await watchRemoteLongPoll({
    baseUrl: args.remote,
    callId,
    token,
    sinceSeq: args.since_seq ?? 0,
    waitS: args.wait,
    transcriptFile: file,
    signal: stop.signal,
  });
  if (res.stopReason === "aborted") {
    process.stderr.write(`[samograph] remote watch stopped at seq ${res.sinceSeq} (resume with --since ${res.sinceSeq})\n`);
    return;
  }
  throw new ExitError(1);
}
