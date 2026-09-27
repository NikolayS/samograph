import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { watch } from "../transcript.ts";
import { ExitError, samographDir } from "../config.ts";
import type { ParsedArgs } from "../args.ts";
import { remoteWatch } from "../remoteWatch.ts";

export async function cmdWatch(args?: ParsedArgs): Promise<void> {
  if (args?.remote) return runRemoteWatch(args);
  await watch();
}

export interface RemoteWatchDeps {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  print?: (line: string) => void;
  log?: (msg: string) => void;
}

/**
 * `samograph watch --remote <site> --call <id> [--mode ws]` (#307): stream a
 * call's transcript from the hosted ws-hub over one outbound WebSocket — no
 * tunnel. Lines are printed and appended to a local transcript file; a
 * `<file>.seq` cursor lets a restart resume with `since_seq` instead of
 * re-reading the call. The share token comes ONLY from SAMOGRAPH_SHARE_TOKEN
 * (never argv, which leaks into `ps`/shell history).
 */
export async function runRemoteWatch(args: ParsedArgs, deps: RemoteWatchDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const token = env.SAMOGRAPH_SHARE_TOKEN;
  if (!token) {
    throw new Error("watch --remote needs a per-call share token in SAMOGRAPH_SHARE_TOKEN");
  }
  const callId = args.call_id!;
  const out = args.out ?? join(samographDir(), `remote_${callId}_transcript.txt`);
  const cursorFile = `${out}.seq`;
  mkdirSync(dirname(out), { recursive: true });

  let sinceSeq = args.since_seq;
  if (sinceSeq === undefined && existsSync(cursorFile)) {
    const n = Number(readFileSync(cursorFile, "utf-8").trim());
    if (Number.isSafeInteger(n) && n >= 0) sinceSeq = n;
  }

  const print = deps.print ?? ((s: string) => process.stdout.write(s + "\n"));
  const log = deps.log ?? ((m: string) => process.stderr.write(`samograph: ${m}\n`));

  let signal = deps.signal;
  if (!signal) {
    const ctl = new AbortController();
    process.once("SIGINT", () => ctl.abort());
    process.once("SIGTERM", () => ctl.abort());
    signal = ctl.signal;
  }

  const res = await remoteWatch({
    site: args.remote!,
    callId,
    token,
    sinceSeq: sinceSeq ?? 0,
    signal,
    log,
    onLine: (rendered, line) => {
      appendFileSync(out, rendered + "\n");
      writeFileSync(cursorFile, `${line.seq}\n`);
      print(rendered);
    },
  });
  if (res.reason === "unauthorized") throw new ExitError(3);
}
