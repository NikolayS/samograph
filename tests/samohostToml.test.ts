import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * .samohost.toml preview-isolation contract.
 *
 * Guards that buildCmd uses the per-env APP_API_PORT variable (injected by
 * samohost before the build phase) rather than the hardcoded prod port 8887.
 *
 * Root-cause (confirmed 2026-07-10): when samohost creates a preview env,
 * the build phase runs BEFORE the envfile phase that writes per-listener
 * portEnv values to .env. Samohost injects the allocated portEnv values as
 * shell variables BEFORE the build phase (from the port allocation result).
 * The prod deploy script sources /opt/samograph/app/.env (which contains
 * APP_API_PORT=8887) before running buildCmd, so prod and preview both have
 * APP_API_PORT in scope at build time.
 *
 * Without this guard, a hardcoded 8887 bakes the PROD app-api port into the
 * Next.js SSR bundle: every preview's SSR calls the real production app-api,
 * reading from — and writing to — the production DB instead of the per-env
 * DBLab clone. A magic-link POST to a public preview URL was observed landing
 * in the PROD magic_links table (not the clone) before this fix.
 *
 * With APP_API_ORIGIN=http://127.0.0.1:${APP_API_PORT}:
 *   prod:    APP_API_PORT=8887 (from .env sourced pre-build) → identical to before
 *   preview: APP_API_PORT=<allocated> (from samohost shell var pre-build) → clone-backed
 */

const TOML_PATH = join(import.meta.dir, "..", ".samohost.toml");

describe(".samohost.toml preview-isolation", () => {
  const toml = readFileSync(TOML_PATH, "utf8");

  // Extract the buildCmd value from the TOML (double-quoted string value).
  const buildCmdMatch = toml.match(/^buildCmd\s*=\s*"([^"]*)"$/m);
  const buildCmd = buildCmdMatch?.[1] ?? "";

  it("buildCmd must not hardcode APP_API_ORIGIN with the prod port 8887", () => {
    // A hardcoded 8887 bakes the PROD app-api port into the Next.js SSR
    // bundle: every preview's SSR calls the real prod app-api, leaking reads
    // (and writes) to the production DB instead of the per-env DBLab clone.
    expect(buildCmd).not.toMatch(/APP_API_ORIGIN=http:\/\/127\.0\.0\.1:8887/);
  });

  it("buildCmd must reference APP_API_PORT via shell variable expansion", () => {
    // The per-env app-api port is in scope at build time (samohost injects it
    // as a shell variable before the build phase; the prod deploy script
    // sources .env which contains APP_API_PORT=8887). Using ${APP_API_PORT}
    // makes the frontend SSR target the per-env clone-backed app-api; in prod
    // APP_API_PORT=8887 so the build output is byte-identical to the
    // previously hardcoded form.
    expect(buildCmd).toMatch(/APP_API_ORIGIN=http:\/\/127\.0\.0\.1:\$\{APP_API_PORT\}/);
  });
});
