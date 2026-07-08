/**
 * Prod app-api entrypoint (`server.ts`) — fail-closed startup (#64, #105).
 *
 * `startAppApiServer(env)` runs the shared `assertNoDevDefaultSecrets` gate
 * BEFORE it constructs the app or binds a port. These tests only exercise the
 * throwing (bad-secret) path, so `Bun.serve` is never reached — no port is
 * bound. The module is guarded by `import.meta.main`, so importing it here does
 * NOT auto-start a server.
 */
import { describe, it, expect } from "bun:test";
import { startAppApiServer } from "./server.ts";
import { DEV_DEFAULT_SECRETS } from "../../packages/shared/config/env.ts";

const goodProdEnv = (): Record<string, string | undefined> => ({
  SAMO_ENV: "prod",
  SESSION_SECRET: "real-session-secret-0123456789abcdef0123456789",
  MAGIC_LINK_SECRET: "real-magic-secret-0123456789abcdef0123456789",
  TOKEN_SECRET: "real-token-secret-0123456789abcdef0123456789",
});

const SIGNING_KEYS = ["SESSION_SECRET", "MAGIC_LINK_SECRET", "TOKEN_SECRET"] as const;

describe("server.ts prod entrypoint — fail-closed before bind (#64)", () => {
  for (const key of SIGNING_KEYS) {
    it(`throws before binding when ${key} is MISSING`, () => {
      const env = goodProdEnv();
      delete env[key];
      expect(() => startAppApiServer(env)).toThrow(new RegExp(key));
    });
    it(`throws before binding when ${key} is the committed dev default`, () => {
      const env = { ...goodProdEnv(), [key]: DEV_DEFAULT_SECRETS[key] };
      expect(() => startAppApiServer(env)).toThrow(new RegExp(key));
    });
  }

  it("throws when SAMO_ENV is absent (defaults to prod) and secrets are dev defaults", () => {
    expect(() => startAppApiServer({ ...DEV_DEFAULT_SECRETS })).toThrow();
  });
});
