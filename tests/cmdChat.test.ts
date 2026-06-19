import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdChat } from "../src/commands/chat.ts";
import type { RecallClient } from "../src/recall.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

function makeRecall(resp: Response): RecallClient {
  return {
    async leaveCall() { return new Response(); },
    async getBot() { return {}; },
    async sendChat() { return resp; },
    async outputAudio() { return new Response("{}", { status: 200 }); },
    async screenshot() { return new Response(); },
    async createBot() { return { id: "x" }; },
  };
}

describe("cmdChat", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
    process.env.RECALL_API_KEY = "fake-key";
    writeFileSync(join(tmp, "state.json"), JSON.stringify({ bot_id: "bot-abc" }));
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("sends chat and prints confirmation on success", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { writes.push(s); return true; };
    try {
      await cmdChat(
        { command: "chat", message: "hello meeting", bot_id: null },
        { recall: makeRecall(new Response("{}", { status: 200 })) },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(writes.join("")).toContain("hello meeting");
  });

  it("plays the chime into the call audio (outputAudio) after a successful send", async () => {
    let audioBotId = "";
    let audioB64 = "";
    const recall: RecallClient = {
      async leaveCall() { return new Response(); },
      async getBot() { return {}; },
      async sendChat() { return new Response("{}", { status: 200 }); },
      async outputAudio(bid: string, b64: string) {
        audioBotId = bid;
        audioB64 = b64;
        return new Response("{}", { status: 200 });
      },
      async screenshot() { return new Response(); },
      async createBot() { return { id: "x" }; },
    };
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    try {
      await cmdChat({ command: "chat", message: "hello", bot_id: null }, { recall });
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(audioBotId).toBe("bot-abc");
    expect(audioB64.length).toBeGreaterThan(0);
  });

  it("still sends chat (and does not throw) when outputAudio fails", async () => {
    const writes: string[] = [];
    const recall: RecallClient = {
      async leaveCall() { return new Response(); },
      async getBot() { return {}; },
      async sendChat() { return new Response("{}", { status: 200 }); },
      async outputAudio() { throw new Error("audio output unavailable"); },
      async screenshot() { return new Response(); },
      async createBot() { return { id: "x" }; },
    };
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { writes.push(s); return true; };
    try {
      await cmdChat({ command: "chat", message: "hello", bot_id: null }, { recall });
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(writes.join("")).toContain("hello");
  });

  it("rings the chime on the local presence server after a successful send", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        bot_id: "bot-abc",
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_write_token: "write-secret",
      }),
    );
    let chimeUrl = "";
    let chimeInit: RequestInit | undefined;
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    try {
      await cmdChat(
        { command: "chat", message: "hello", bot_id: null },
        {
          recall: makeRecall(new Response("{}", { status: 200 })),
          fetchFn: async (url, init) => {
            chimeUrl = String(url);
            chimeInit = init;
            return new Response("{}", { status: 200 });
          },
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(chimeUrl).toBe("http://127.0.0.1:8080/chime");
    expect(chimeInit?.method).toBe("POST");
    expect((chimeInit?.headers as Record<string, string>)["X-Samograph-Presence-Token"]).toBe(
      "write-secret",
    );
  });

  it("does not ring the chime (or fail) when no presence server is in state", async () => {
    let chimeCalled = false;
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    try {
      await cmdChat(
        { command: "chat", message: "hello", bot_id: null },
        {
          recall: makeRecall(new Response("{}", { status: 200 })),
          fetchFn: async () => { chimeCalled = true; return new Response("{}", { status: 200 }); },
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(chimeCalled).toBe(false);
  });

  it("still sends chat even if the chime ping throws", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        bot_id: "bot-abc",
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_write_token: "write-secret",
      }),
    );
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { writes.push(s); return true; };
    try {
      await cmdChat(
        { command: "chat", message: "hello", bot_id: null },
        {
          recall: makeRecall(new Response("{}", { status: 200 })),
          fetchFn: async () => { throw new Error("connection refused"); },
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect(writes.join("")).toContain("hello");
  });

  it("throws on non-ok response", async () => {
    const errResp = new Response("Forbidden", { status: 403 });
    let threw = false;
    try {
      await cmdChat(
        { command: "chat", message: "hi", bot_id: null },
        { recall: makeRecall(errResp) },
      );
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain("403");
    }
    expect(threw).toBe(true);
  });

  it("uses explicit bot_id when provided", async () => {
    let capturedBotId = "";
    const recall: RecallClient = {
      async leaveCall() { return new Response(); },
      async getBot() { return {}; },
      async sendChat(bid: string) { capturedBotId = bid; return new Response("{}", { status: 200 }); },
      async outputAudio() { return new Response("{}", { status: 200 }); },
      async screenshot() { return new Response(); },
      async createBot() { return { id: "x" }; },
    };
    await cmdChat(
      { command: "chat", message: "test", bot_id: "explicit-bot" },
      { recall },
    );
    expect(capturedBotId).toBe("explicit-bot");
  });

  it("falls back to state bot_id when not explicit", async () => {
    let capturedBotId = "";
    const recall: RecallClient = {
      async leaveCall() { return new Response(); },
      async getBot() { return {}; },
      async sendChat(bid: string) { capturedBotId = bid; return new Response("{}", { status: 200 }); },
      async outputAudio() { return new Response("{}", { status: 200 }); },
      async screenshot() { return new Response(); },
      async createBot() { return { id: "x" }; },
    };
    await cmdChat({ command: "chat", message: "test", bot_id: null }, { recall });
    expect(capturedBotId).toBe("bot-abc");
  });

  it("exits when no state and no explicit bot_id", async () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({}));
    let threw = false;
    try {
      await cmdChat(
        { command: "chat", message: "hi", bot_id: null },
        { recall: makeRecall(new Response("{}", { status: 200 })) },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
