/**
 * Dev app-api wrapper (`dev-server.ts`) — refuses to boot outside SAMO_ENV=dev.
 *
 * dev-server.ts carries the LOCAL-ONLY shortcuts (dev-default secret fallbacks,
 * the `Secure`-strip, `GET /__dev/last-magic-link`). If a prod box mistakenly
 * launches it, it MUST hard-throw before doing anything — the gate is
 * `SAMO_ENV === 'dev'` (default prod = fail-safe). The module is guarded by
 * `import.meta.main`, so importing it here does NOT auto-start a server.
 */
import { describe, it, expect } from "bun:test";
import { assertDevEnv, startDevServer } from "./dev-server.ts";

describe("dev-server.ts — DEV-ONLY boot gate", () => {
  it("assertDevEnv throws when SAMO_ENV is absent (defaults to prod)", () => {
    expect(() => assertDevEnv({})).toThrow(/SAMO_ENV/);
  });
  it("assertDevEnv throws when SAMO_ENV=prod", () => {
    expect(() => assertDevEnv({ SAMO_ENV: "prod" })).toThrow(/dev/i);
  });
  it("assertDevEnv does NOT throw when SAMO_ENV=dev", () => {
    expect(() => assertDevEnv({ SAMO_ENV: "dev" })).not.toThrow();
  });
  it("startDevServer throws (before any bind/connect) when SAMO_ENV!=dev", () => {
    expect(() =>
      startDevServer({ SAMO_ENV: "prod", DATABASE_URL: "postgres://x/y" }),
    ).toThrow();
  });
});
