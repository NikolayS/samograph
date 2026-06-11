import { existsSync, unlinkSync, appendFileSync } from "node:fs";
import { stateFile } from "../config.ts";
import { loadState, botIdFromArgsOrState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";
import { makeRecallClient, type RecallClient } from "../recall.ts";

export interface LeaveDeps {
  recall?: RecallClient;
  /** Send a signal to a pid. Should throw on ProcessLookupError-equivalent. */
  kill?: (pid: number, signal: string) => void;
  now?: () => Date;
}

function defaultKill(pid: number, signal: string): void {
  // process.kill throws ESRCH when the process does not exist; let it throw
  // so the caller can mirror Python's ProcessLookupError handling.
  process.kill(pid, signal as NodeJS.Signals);
}

function fmtSentinelTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function cmdLeave(
  args: ParsedArgs,
  deps: LeaveDeps = {},
): Promise<void> {
  const recall = deps.recall ?? makeRecallClient();
  const kill = deps.kill ?? defaultKill;
  const now = deps.now ?? (() => new Date());

  const bid = botIdFromArgsOrState(args.bot_id);
  try {
    await recall.leaveCall(bid);
    process.stdout.write(`Bot ${bid} left the call.\n`);
  } catch (e) {
    process.stdout.write(`Warning: ${e}\n`);
  }

  const state = loadState();

  // Write sentinel line so `samograph watch` exits cleanly.
  const transcriptFile = state.transcript_file;
  if (typeof transcriptFile === "string" && transcriptFile) {
    if (existsSync(transcriptFile)) {
      const ts = fmtSentinelTs(now());
      try {
        appendFileSync(transcriptFile, `[${ts}] SAMOGRAPH_CALL_ENDED\n`);
      } catch {
        // OSError equivalent — ignore
      }
    }
  }

  for (const pidKey of ["server_pid", "ngrok_pid", "tunnel_pid", "mediamtx_pid"] as const) {
    const pid = state[pidKey];
    if (typeof pid === "number" && pid) {
      try {
        kill(pid, "SIGTERM");
        process.stdout.write(
          `Stopped ${pidKey.replace("_pid", "")} (pid ${pid})\n`,
        );
      } catch (e: unknown) {
        // ProcessLookupError equivalent (ESRCH) — process already gone; swallow.
        if ((e as { code?: string }).code !== "ESRCH") {
          // Other errors are also tolerated to match permissive Python behavior.
        }
      }
    }
  }

  if (existsSync(stateFile())) {
    unlinkSync(stateFile());
  }
  process.stdout.write("Done.\n");
}
