import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveServeOptions } from "../src/commands/serve.ts";
import { saveEnv, restoreEnv } from "./helpers.ts";
import type { ParsedArgs } from "../src/args.ts";

function serveArgs(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "_serve",
    port: 8080,
    transcript_file: "/tmp/transcript.txt",
    webhook_token: "",
    frame_token: "",
    presence_token: "",
    presence_write_token: "",
    call_id_file: "",
    ...over,
  } as ParsedArgs;
}

describe("resolveServeOptions", () => {
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    delete process.env.SAMOCALL_WEBHOOK_TOKEN;
    delete process.env.SAMOCALL_FRAME_TOKEN;
    delete process.env.SAMOCALL_PRESENCE_TOKEN;
    delete process.env.SAMOCALL_PRESENCE_WRITE_TOKEN;
  });

  afterEach(() => {
    restoreEnv(env);
  });

  it("falls back to env vars when token flags are absent", () => {
    process.env.SAMOCALL_WEBHOOK_TOKEN = "env-webhook";
    process.env.SAMOCALL_FRAME_TOKEN = "env-frame";
    process.env.SAMOCALL_PRESENCE_TOKEN = "env-presence";
    process.env.SAMOCALL_PRESENCE_WRITE_TOKEN = "env-presence-write";

    const opts = resolveServeOptions(serveArgs());
    expect(opts.webhookToken).toBe("env-webhook");
    expect(opts.frameToken).toBe("env-frame");
    expect(opts.presenceToken).toBe("env-presence");
    expect(opts.presenceWriteToken).toBe("env-presence-write");
  });

  it("prefers explicit flags over env vars", () => {
    process.env.SAMOCALL_WEBHOOK_TOKEN = "env-webhook";
    const opts = resolveServeOptions(serveArgs({ webhook_token: "flag-webhook" }));
    expect(opts.webhookToken).toBe("flag-webhook");
  });

  it("yields empty tokens when neither flags nor env are set", () => {
    const opts = resolveServeOptions(serveArgs());
    expect(opts.webhookToken).toBe("");
    expect(opts.frameToken).toBe("");
    expect(opts.presenceToken).toBe("");
    expect(opts.presenceWriteToken).toBe("");
  });
});
