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
import {
  startAppApiServer,
  assertGoogleWebOriginConfigured,
  APP_API_WEB_ORIGIN_FALLBACK,
  formatCalendarStartupLine,
} from "./server.ts";
import {
  DEV_DEFAULT_SECRETS,
  resolveMagicLinkBaseUrl,
} from "../../packages/shared/config/env.ts";
import { GoogleOAuthError, googleOAuthFromEnv } from "./auth/index.ts";
import { resolveCalendarConfig } from "./calendar/resolve-config.ts";

const goodProdEnv = (): Record<string, string | undefined> => ({
  SAMO_ENV: "prod",
  SESSION_SECRET: "real-session-secret-0123456789abcdef0123456789",
  MAGIC_LINK_SECRET: "real-magic-secret-0123456789abcdef0123456789",
  TOKEN_SECRET: "real-token-secret-0123456789abcdef0123456789",
});

const SIGNING_KEYS = ["SESSION_SECRET", "MAGIC_LINK_SECRET", "TOKEN_SECRET"] as const;

describe("server.ts startup banner — Google Calendar", () => {
  it("reports enabled without exposing encryption key material", () => {
    const keyMaterial = Buffer.alloc(32, 7).toString("base64");
    const config = resolveCalendarConfig({
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION: "7",
      CALENDAR_TOKEN_ENCRYPTION_KEY: keyMaterial,
      CALENDAR_TOKEN_DECRYPTION_KEYS: JSON.stringify({ 7: keyMaterial }),
    }, "https://samograph.dev");
    const line = formatCalendarStartupLine(config);
    expect(line).toBe("  Google Calendar: enabled\n");
    expect(line).not.toContain(keyMaterial);
  });

  it("reports the explicit opt-in reason when disabled", () => {
    expect(formatCalendarStartupLine({ googleCalendarOAuth: undefined, calendarTokenEncryption: undefined })).toBe(
      "  Google Calendar: disabled (no CALENDAR_TOKEN_* configured)\n",
    );
  });
});

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

/**
 * The hard-coded `https://samograph.dev` web-origin fallback must never be
 * SILENTLY accepted as a Google redirect origin (#209; restores the property
 * #236 deliberately gave up, per finding 1 of that PR's samorev review).
 *
 * #236 allowlisted `https://samograph.dev`, which is exactly the literal
 * `server.ts` falls back to when an environment sets NEITHER `BASE_URL` nor
 * `WEB_ORIGIN`. Before #236 that state failed `deriveRedirectUri`'s
 * registered-origin check and the process refused to boot; after it, the same
 * misconfiguration boots happily and every user's Google click dies at Google
 * with `redirect_uri_mismatch` — later, quieter, and in Google's logs rather
 * than ours.
 *
 * The guard is Google-SCOPED on purpose. The magic-link base URL keeps its
 * `samograph.dev` default for every environment, so an env with no Google
 * credentials at all is completely unaffected.
 */
describe("server.ts — the hard-coded fallback is never silently a Google origin (#209)", () => {
  // Obviously-fake fixtures, shaped like the real thing. NEVER a real credential.
  const FAKE_CLIENT_ID = "111111111111-notarealclient.apps.googleusercontent.com";
  const FAKE_CLIENT_SECRET = "GOCSPX-not-a-real-secret-fixture";

  const googleEnv = (): Record<string, string | undefined> => ({
    ...goodProdEnv(),
    GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  });

  const EXPECTED_MESSAGE =
    "Google sign-in is configured but this environment sets neither BASE_URL nor " +
    "WEB_ORIGIN, so the Google redirect URI would silently derive from the " +
    "hard-coded https://samograph.dev fallback in apps/app-api/server.ts and every " +
    "sign-in would die at Google with redirect_uri_mismatch — set BASE_URL (or " +
    "WEB_ORIGIN) to THIS environment's own public origin, or set " +
    "GOOGLE_OAUTH_REDIRECT_URI explicitly to the URI registered for this host";

  it("pins the hard-coded fallback as EXACTLY https://samograph.dev", () => {
    // The magic-link default is UNCHANGED by this guard — pinned so a future
    // edit to it has to show up as a deliberate line in a diff.
    expect(APP_API_WEB_ORIGIN_FALLBACK).toBe("https://samograph.dev");
    expect(resolveMagicLinkBaseUrl(googleEnv(), APP_API_WEB_ORIGIN_FALLBACK)).toBe(
      "https://samograph.dev",
    );
  });

  it("THROWS the exact message when neither BASE_URL nor WEB_ORIGIN is set and Google is configured", () => {
    expect(() => assertGoogleWebOriginConfigured(googleEnv())).toThrow(EXPECTED_MESSAGE);
    let thrown: unknown;
    try {
      assertGoogleWebOriginConfigured(googleEnv());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GoogleOAuthError);
    expect((thrown as Error).name).toBe("GoogleOAuthError");
    expect((thrown as Error).message).toBe(EXPECTED_MESSAGE);
  });

  it("NEVER echoes a credential value in the message", () => {
    let message = "";
    try {
      assertGoogleWebOriginConfigured(googleEnv());
    } catch (error) {
      message = (error as Error).message;
    }
    // The guard MUST have fired — an empty message would pass the `not.toContain`
    // assertions below vacuously.
    expect(message).toBe(EXPECTED_MESSAGE);
    expect(message).not.toContain(FAKE_CLIENT_ID);
    expect(message).not.toContain(FAKE_CLIENT_SECRET);
    expect(message).not.toContain("notarealclient");
    expect(message).not.toContain("GOCSPX");
  });

  it("fires for EITHER credential alone — the same notion of configured googleOAuthFromEnv gates on", () => {
    const idOnly = googleEnv();
    delete idOnly.GOOGLE_OAUTH_CLIENT_SECRET;
    expect(() => assertGoogleWebOriginConfigured(idOnly)).toThrow(EXPECTED_MESSAGE);
    const secretOnly = googleEnv();
    delete secretOnly.GOOGLE_OAUTH_CLIENT_ID;
    expect(() => assertGoogleWebOriginConfigured(secretOnly)).toThrow(EXPECTED_MESSAGE);
  });

  it("does NOT throw when GOOGLE_OAUTH_REDIRECT_URI is set — the operator asserted the host", () => {
    const env = {
      ...googleEnv(),
      GOOGLE_OAUTH_REDIRECT_URI: "https://samograph-somebranch.samo.cat/auth/google/callback",
    };
    expect(() => assertGoogleWebOriginConfigured(env)).not.toThrow();
    // …and the override still wins end to end, byte for byte.
    const provider = googleOAuthFromEnv(
      env,
      resolveMagicLinkBaseUrl(env, APP_API_WEB_ORIGIN_FALLBACK),
    );
    expect(provider?.redirectUri).toBe(
      "https://samograph-somebranch.samo.cat/auth/google/callback",
    );
  });

  it("does NOT throw when NO Google credential is set — zero blast radius for a non-Google env", () => {
    const env = goodProdEnv();
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(() => assertGoogleWebOriginConfigured(env)).not.toThrow();
    // The magic-link base URL for that env is UNCHANGED: still the fallback.
    expect(resolveMagicLinkBaseUrl(env, APP_API_WEB_ORIGIN_FALLBACK)).toBe(
      "https://samograph.dev",
    );
    // Blank/whitespace-only credentials are "absent" here exactly as they are
    // for googleOAuthFromEnv — one notion of "configured", not two.
    const blank = { ...goodProdEnv(), GOOGLE_OAUTH_CLIENT_ID: "  ", GOOGLE_OAUTH_CLIENT_SECRET: "" };
    expect(() => assertGoogleWebOriginConfigured(blank)).not.toThrow();
    expect(googleOAuthFromEnv(blank, "https://samograph.samo.team")).toBeUndefined();
  });

  it("does NOT throw when WEB_ORIGIN is set, and derives EXACTLY https://samograph.samo.team/auth/google/callback", () => {
    const env = { ...googleEnv(), WEB_ORIGIN: "https://samograph.samo.team" };
    expect(() => assertGoogleWebOriginConfigured(env)).not.toThrow();
    const provider = googleOAuthFromEnv(
      env,
      resolveMagicLinkBaseUrl(env, APP_API_WEB_ORIGIN_FALLBACK),
    );
    expect(provider?.redirectUri).toBe("https://samograph.samo.team/auth/google/callback");
  });

  it("does NOT throw when BASE_URL is set, and derives EXACTLY https://samograph-main.samo.cat/auth/google/callback", () => {
    const env = { ...googleEnv(), BASE_URL: "https://samograph-main.samo.cat" };
    expect(() => assertGoogleWebOriginConfigured(env)).not.toThrow();
    const provider = googleOAuthFromEnv(
      env,
      resolveMagicLinkBaseUrl(env, APP_API_WEB_ORIGIN_FALLBACK),
    );
    expect(provider?.redirectUri).toBe("https://samograph-main.samo.cat/auth/google/callback");
  });

  it("is WIRED INTO startAppApiServer — throws before Postgres or a port is touched", () => {
    // If the guard were not called from the entrypoint, this would instead fail
    // trying to `connect()`, so this pins the call site, not just the helper.
    expect(() => startAppApiServer(googleEnv())).toThrow(EXPECTED_MESSAGE);
  });

  it("leaves dev (SAMO_ENV=dev) unaffected — the dev entrypoint's own default origin is registered", () => {
    // dev-server.ts passes `http://localhost:3000` as its fallback, which IS a
    // registered origin, so the trap this guard closes does not exist there and
    // dev-server.ts is deliberately untouched.
    const env = {
      SAMO_ENV: "dev",
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    };
    expect(resolveMagicLinkBaseUrl(env, "http://localhost:3000")).toBe("http://localhost:3000");
    const provider = googleOAuthFromEnv(env, resolveMagicLinkBaseUrl(env, "http://localhost:3000"));
    expect(provider?.redirectUri).toBe("http://localhost:3000/auth/google/callback");
  });
});
