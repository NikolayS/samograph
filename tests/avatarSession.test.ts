import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../src/server.ts";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";
import { createAvatarFake } from "../packages/test-fakes/avatar/index.ts";
import type { AvatarProvider } from "../src/avatar.ts";

const TOKENS = {
  webhookToken: "webhook-token",
  presenceToken: "read-token",
  presenceWriteToken: "write-token",
};

const READ = { "X-Samograph-Presence-Token": "read-token" };
const WRITE = { "Content-Type": "application/json", "X-Samograph-Presence-Token": "write-token" };

describe("GET /avatar/session", () => {
  let tmp: string;
  let tf: string;
  beforeEach(() => {
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
  });
  afterEach(() => cleanupTmpDir(tmp));

  it("403 without the presence read token", async () => {
    const server = serve(0, tf, {
      ...TOKENS,
      avatarProvider: createAvatarFake({ seed: "s" }),
      avatarPersonaId: "persona-1",
    });
    try {
      const resp = await fetch(`http://localhost:${server.port}/avatar/session`);
      expect(resp.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  it("enabled:true with a minted sessionToken when provider + persona are configured", async () => {
    const server = serve(0, tf, {
      ...TOKENS,
      avatarProvider: createAvatarFake({ seed: "s" }),
      avatarPersonaId: "persona-1",
    });
    try {
      const resp = await fetch(`http://localhost:${server.port}/avatar/session`, { headers: READ });
      expect(resp.status).toBe(200);
      const json = (await resp.json()) as {
        enabled: boolean;
        personaId: string;
        sessionToken: string;
      };
      expect(json.enabled).toBe(true);
      expect(json.personaId).toBe("persona-1");
      expect(typeof json.sessionToken).toBe("string");
      expect(json.sessionToken.length).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  it("enabled:false (200) when no provider is configured", async () => {
    const server = serve(0, tf, { ...TOKENS });
    try {
      const resp = await fetch(`http://localhost:${server.port}/avatar/session`, { headers: READ });
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { enabled: boolean }).enabled).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("enabled:false (200) when the persona id is empty", async () => {
    const server = serve(0, tf, {
      ...TOKENS,
      avatarProvider: createAvatarFake({ seed: "s" }),
      avatarPersonaId: "",
    });
    try {
      const resp = await fetch(`http://localhost:${server.port}/avatar/session`, { headers: READ });
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { enabled: boolean }).enabled).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("enabled:false (200, never 500) when minting throws (e.g. missing key)", async () => {
    const throwing: AvatarProvider = {
      name: "throwing",
      async mintSession() {
        throw new Error("ANAM_API_KEY not set");
      },
    };
    const server = serve(0, tf, { ...TOKENS, avatarProvider: throwing, avatarPersonaId: "persona-1" });
    try {
      const resp = await fetch(`http://localhost:${server.port}/avatar/session`, { headers: READ });
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { enabled: boolean }).enabled).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("the response carries only the minted token, never a bearer/api key", async () => {
    const server = serve(0, tf, {
      ...TOKENS,
      avatarProvider: createAvatarFake({ seed: "s" }),
      avatarPersonaId: "persona-1",
    });
    try {
      const resp = await fetch(`http://localhost:${server.port}/avatar/session`, { headers: READ });
      const text = await resp.text();
      expect(text).not.toContain("Bearer");
    } finally {
      server.stop(true);
    }
  });
});

describe("POST /presence drives the speak queue from the speaking state", () => {
  let tmp: string;
  let tf: string;
  beforeEach(() => {
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
  });
  afterEach(() => cleanupTmpDir(tmp));

  async function readSnapshot(port: number | undefined) {
    const r = await fetch(`http://localhost:${port}/presence.json`, { headers: READ });
    return (await r.json()) as { state: string; speak: { text: string; at: string } | null };
  }

  it("speaking + message sets speak.text", async () => {
    const server = serve(0, tf, { ...TOKENS });
    try {
      const upd = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: WRITE,
        body: JSON.stringify({ state: "speaking", message: "Hello from the avatar" }),
      });
      expect(upd.status).toBe(200);
      const snap = await readSnapshot(server.port);
      expect(snap.state).toBe("speaking");
      expect(snap.speak).not.toBeNull();
      expect(snap.speak!.text).toBe("Hello from the avatar");
      expect(typeof snap.speak!.at).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  it("a non-speaking state with a message does NOT speak", async () => {
    const server = serve(0, tf, { ...TOKENS });
    try {
      await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: WRITE,
        body: JSON.stringify({ state: "thinking", message: "Checking indexes" }),
      });
      expect((await readSnapshot(server.port)).speak).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("a bare speaking toggle (no message) does NOT speak", async () => {
    const server = serve(0, tf, { ...TOKENS });
    try {
      await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: WRITE,
        body: JSON.stringify({ state: "speaking" }),
      });
      expect((await readSnapshot(server.port)).speak).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
