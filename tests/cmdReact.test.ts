import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitError } from "../src/config.ts";
import { cmdReact } from "../src/commands/react.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

describe("cmdReact", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_STATE_FILE = join(tmp, "state.json");
  });

  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  function writeState(): void {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        local_presence_update_url: "http://127.0.0.1:8080/presence",
        presence_token: "read-secret",
        presence_write_token: "write-secret",
      }),
    );
  }

  it("posts the reaction to the /reaction endpoint with the write token", async () => {
    writeState();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => { writes.push(s); return true; };
    try {
      await cmdReact(
        { command: "react", emoji: "🎉", reaction_count: 5 },
        {
          fetchFn: async (url, init) => {
            capturedUrl = String(url);
            capturedInit = init;
            return Response.json({ ok: true, reaction: { emoji: "🎉", count: 5 } });
          },
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }

    expect(capturedUrl).toBe("http://127.0.0.1:8080/reaction");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["X-Samograph-Presence-Token"]).toBe(
      "write-secret",
    );
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ emoji: "🎉", count: 5 });
    expect(writes.join("")).toContain("Reaction: 🎉 x5");
  });

  it("defaults the count when none is given", async () => {
    writeState();
    let body: unknown;
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    try {
      await cmdReact(
        { command: "react", emoji: "👍" },
        {
          fetchFn: async (_url, init) => {
            body = JSON.parse(init?.body as string);
            return Response.json({ ok: true });
          },
        },
      );
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    expect((body as { emoji: string; count: number }).emoji).toBe("👍");
    expect((body as { emoji: string; count: number }).count).toBe(8);
  });

  it("rejects an empty emoji before contacting the server", async () => {
    writeState();
    let called = false;
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = () => true;
    try {
      await expect(
        cmdReact(
          { command: "react", emoji: "   " },
          { fetchFn: async () => { called = true; return Response.json({ ok: true }); } },
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }
    expect(called).toBe(false);
  });

  it("errors when no presence server is recorded in state", async () => {
    writeFileSync(join(tmp, "state.json"), JSON.stringify({}));
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = () => true;
    try {
      await expect(
        cmdReact(
          { command: "react", emoji: "🎉" },
          { fetchFn: async () => Response.json({ ok: true }) },
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      (process.stderr.write as unknown) = orig;
    }
  });
});
