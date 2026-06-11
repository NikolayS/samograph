import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ExitError } from "../src/config.ts";
import { cmdLeave } from "../src/commands/leave.ts";
import type { RecallClient } from "../src/recall.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

interface LeaveCall {
  botId: string;
}

function makeFakeRecall(leaveCalls: LeaveCall[]): RecallClient {
  return {
    async leaveCall(botId: string) {
      leaveCalls.push({ botId });
      return new Response("{}", { status: 200 });
    },
    async getBot() {
      return {};
    },
    async sendChat() {
      return new Response("{}", { status: 200 });
    },
    async screenshot() {
      return new Response("{}", { status: 200 });
    },
    async createBot() {
      return { id: "x" };
    },
  };
}

describe("cmdLeave", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  let sf: string;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    sf = join(tmp, "state.json");
    process.env.SAMOGRAPH_STATE_FILE = sf;
    process.env.RECALL_API_KEY = "fake-key";
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("calls recall leave endpoint", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-xyz" }));
    const calls: LeaveCall[] = [];
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall(calls),
      kill: () => {},
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.botId).toBe("bot-xyz");
  });

  it("kills server pid", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-1", server_pid: 1111 }));
    const killed: Array<[number, string]> = [];
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: (pid, sig) => killed.push([pid, sig]),
    });
    expect(killed).toContainEqual([1111, "SIGTERM"]);
  });

  it("kills ngrok pid", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-1", ngrok_pid: 2222 }));
    const killed: Array<[number, string]> = [];
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: (pid, sig) => killed.push([pid, sig]),
    });
    expect(killed).toContainEqual([2222, "SIGTERM"]);
  });

  it("kills mediamtx pid", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-1", mediamtx_pid: 3333 }));
    const killed: Array<[number, string]> = [];
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: (pid, sig) => killed.push([pid, sig]),
    });
    expect(killed).toContainEqual([3333, "SIGTERM"]);
  });

  it("removes state file", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-del" }));
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: () => {},
    });
    expect(existsSync(sf)).toBe(false);
  });

  it("tolerates missing pids", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-nopid" }));
    const killed: Array<[number, string]> = [];
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: (pid, sig) => killed.push([pid, sig]),
    });
    expect(killed.length).toBe(0);
  });

  it("tolerates process lookup error", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "bot-gone", server_pid: 9999 }));
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: () => {
        const err = new Error("no such process") as Error & { code: string };
        err.code = "ESRCH";
        throw err;
      },
    });
    // Should not throw — completes
    expect(existsSync(sf)).toBe(false);
  });

  it("uses bot_id from args when provided", async () => {
    writeFileSync(sf, JSON.stringify({ bot_id: "state-bot" }));
    const calls: LeaveCall[] = [];
    await cmdLeave({ command: "leave", bot_id: "explicit-bot" }, {
      recall: makeFakeRecall(calls),
      kill: () => {},
    });
    expect(calls[0]!.botId).toBe("explicit-bot");
  });

  it("exits when no bot_id and no state", async () => {
    // no state file written
    let code = -1;
    try {
      await cmdLeave({ command: "leave", bot_id: null }, {
        recall: makeFakeRecall([]),
        kill: () => {},
      });
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("writes sentinel to transcript", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "[2026-05-28 09:59:00] Alice: Hello\n");
    writeFileSync(
      sf,
      JSON.stringify({ bot_id: "bot-sentinel", transcript_file: tf }),
    );
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: () => {},
    });
    expect(readFileSync(tf, "utf-8")).toContain("SAMOGRAPH_CALL_ENDED");
  });

  it("sentinel line format", async () => {
    const tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
    writeFileSync(
      sf,
      JSON.stringify({ bot_id: "bot-fmt", transcript_file: tf }),
    );
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: () => {},
    });
    const content = readFileSync(tf, "utf-8").trim();
    const pattern =
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] SAMOGRAPH_CALL_ENDED$/;
    expect(pattern.test(content)).toBe(true);
  });

  it("sentinel not written when transcript missing", async () => {
    writeFileSync(
      sf,
      JSON.stringify({
        bot_id: "bot-notf",
        transcript_file: join(tmp, "nonexistent.txt"),
      }),
    );
    // Should not throw
    await cmdLeave({ command: "leave", bot_id: null }, {
      recall: makeFakeRecall([]),
      kill: () => {},
    });
    expect(existsSync(join(tmp, "nonexistent.txt"))).toBe(false);
  });
});
