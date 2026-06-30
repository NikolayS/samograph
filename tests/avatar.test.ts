import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  ANAM_BASE,
  anamApiKey,
  makeAnamAvatarProvider,
  type AvatarProvider,
} from "../src/avatar.ts";
import { saveEnv, restoreEnv } from "./helpers.ts";

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Build a fake fetch that records each call and returns a configurable response. */
function makeFakeFetch(next: () => Response) {
  const calls: Captured[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    const h = (init.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(h)) headers[k] = h[k]!;
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // leave raw
      }
    }
    calls.push({ url, method: init.method, headers, body });
    return next();
  };
  return { fetchFn, calls };
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("anam avatar provider", () => {
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => {
    restoreEnv(env);
  });

  it("ANAM_BASE is the v1 endpoint", () => {
    expect(ANAM_BASE).toBe("https://api.anam.ai/v1");
  });

  it("anamApiKey returns the key when set", () => {
    process.env.ANAM_API_KEY = "anam-secret-key";
    expect(anamApiKey()).toBe("anam-secret-key");
  });

  it("anamApiKey throws a plain Error (not a process exit) when unset", () => {
    delete process.env.ANAM_API_KEY;
    expect(() => anamApiKey()).toThrow(/ANAM_API_KEY/);
  });

  it("mintSession -> POST .../auth/session-token with bearer auth and personaId", async () => {
    process.env.ANAM_API_KEY = "anam-secret-key";
    const { fetchFn, calls } = makeFakeFetch(() =>
      jsonResponse({ sessionToken: "sess-abc", expiresAt: "2026-06-30T00:10:00.000Z" }),
    );
    const provider = makeAnamAvatarProvider(fetchFn);
    const session = await provider.mintSession("persona-123");

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${ANAM_BASE}/auth/session-token`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer anam-secret-key");
    // Published persona => id nested under personaConfig (a bare { personaId }
    // mints a legacy token the SDK rejects).
    expect(calls[0]!.body).toEqual({ personaConfig: { personaId: "persona-123" } });

    expect(session.sessionToken).toBe("sess-abc");
    expect(session.personaId).toBe("persona-123");
    expect(session.expiresAt).toBe("2026-06-30T00:10:00.000Z");
  });

  it("mintSession throws before any network call when ANAM_API_KEY is unset", async () => {
    delete process.env.ANAM_API_KEY;
    const { fetchFn, calls } = makeFakeFetch(() => jsonResponse({ sessionToken: "x" }));
    const provider = makeAnamAvatarProvider(fetchFn);
    await expect(provider.mintSession("persona-123")).rejects.toThrow(/ANAM_API_KEY/);
    expect(calls.length).toBe(0);
  });

  it("mintSession surfaces a non-OK Anam status", async () => {
    process.env.ANAM_API_KEY = "anam-secret-key";
    const { fetchFn } = makeFakeFetch(() => new Response("nope", { status: 401 }));
    const provider = makeAnamAvatarProvider(fetchFn);
    await expect(provider.mintSession("persona-123")).rejects.toThrow(/401/);
  });

  it("mintSession rejects a response missing sessionToken", async () => {
    process.env.ANAM_API_KEY = "anam-secret-key";
    const { fetchFn } = makeFakeFetch(() => jsonResponse({ notAToken: true }));
    const provider = makeAnamAvatarProvider(fetchFn);
    await expect(provider.mintSession("persona-123")).rejects.toThrow(/sessionToken/);
  });

  it("never leaks the API key into the returned session object", async () => {
    process.env.ANAM_API_KEY = "super-secret-do-not-leak";
    const { fetchFn } = makeFakeFetch(() => jsonResponse({ sessionToken: "t" }));
    const provider: AvatarProvider = makeAnamAvatarProvider(fetchFn);
    const session = await provider.mintSession("p");
    expect(JSON.stringify(session)).not.toContain("super-secret-do-not-leak");
    expect(provider.name).toBe("anam");
  });
});
