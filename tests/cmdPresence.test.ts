import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitError } from "../src/config.ts";
import { cmdPresence } from "../src/commands/presence.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

describe("cmdPresence", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOCALL_STATE_FILE = join(tmp, "state.json");
  });

  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("posts state update to the local presence server with the write token", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_token: "read-secret",
        presence_write_token: "write-secret",
      }),
    );

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { writes.push(s); return true; };
    try {
      await cmdPresence(
        { command: "presence", presence_state: "thinking", message: "Checking indexes" },
        {
          fetchFn: async (url, init) => {
            capturedUrl = String(url);
            capturedInit = init;
            return Response.json({ ok: true, presence: { state: "thinking" } });
          },
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }

    expect(capturedUrl).toBe("http://127.0.0.1:8080/presence");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect((capturedInit?.headers as Record<string, string>)["X-Samocall-Presence-Token"]).toBe(
      "write-secret",
    );
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      state: "thinking",
      message: "Checking indexes",
    });
    expect(writes.join("")).toContain("Presence: thinking");
  });

  it("omits message from the POST body for bare state toggles but prints the default", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_write_token: "write-secret",
      }),
    );

    let capturedInit: RequestInit | undefined;
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { writes.push(s); return true; };
    try {
      await cmdPresence(
        { command: "presence", presence_state: "idle" },
        {
          fetchFn: async (_url, init) => {
            capturedInit = init;
            return Response.json({ ok: true, presence: { state: "idle" } });
          },
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }

    expect(JSON.parse(capturedInit?.body as string)).toEqual({ state: "idle" });
    expect(writes.join("")).toContain("Presence: idle - Idle");
  });

  it("throws ExitError when no active presence server is in state", async () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({ bot_id: "bot-123" }));

    await expect(
      cmdPresence({ command: "presence", presence_state: "speaking" }),
    ).rejects.toBeInstanceOf(ExitError);
  });

  it("rejects invalid presence state before network call", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_write_token: "write-secret",
      }),
    );

    let called = false;
    await expect(
      cmdPresence(
        { command: "presence", presence_state: "confused" },
        { fetchFn: async () => { called = true; return Response.json({ ok: true }); } },
      ),
    ).rejects.toBeInstanceOf(ExitError);
    expect(called).toBe(false);
  });

  it("non-2xx response yields friendly stderr message and ExitError", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_write_token: "write-secret",
      }),
    );

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    try {
      await expect(
        cmdPresence(
          { command: "presence", presence_state: "thinking" },
          { fetchFn: async () => new Response("boom", { status: 500 }) },
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }
    expect(errWrites.join("")).toContain("Error: presence update failed");
    expect(errWrites.join("")).toContain("500");
  });

  it("connection error yields friendly stderr message and ExitError", async () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_write_token: "write-secret",
      }),
    );

    const errWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => { errWrites.push(s); return true; };
    try {
      await expect(
        cmdPresence(
          { command: "presence", presence_state: "thinking" },
          { fetchFn: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8080"); } },
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }
    expect(errWrites.join("")).toContain("Error: presence update failed");
    expect(errWrites.join("")).toContain("ECONNREFUSED");
  });
});
