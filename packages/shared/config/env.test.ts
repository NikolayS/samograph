/**
 * Shared prod fail-closed secret guard (issue #64).
 *
 * `assertNoDevDefaultSecrets` is the single hard gate both live prod entrypoints
 * (`apps/app-api/server.ts`, `apps/ws-hub/dev-live-server.ts`) run BEFORE they
 * bind a port: in prod it throws (→ non-zero exit) when any signing secret is
 * missing or still equal to its committed public dev-default literal; in dev it
 * is a no-op so `scripts/dev-local.sh` (which uses the dev defaults) still runs.
 */
import { describe, it, expect } from "bun:test";
import {
  assertNoDevDefaultSecrets,
  usingDevDefaultSecrets,
  resolveSamoEnv,
  resolveMagicLinkBaseUrl,
  DEV_DEFAULT_SECRETS,
  APP_API_SIGNING_SECRETS,
  WS_HUB_SIGNING_SECRETS,
} from "./env.ts";

const goodProd = (): Record<string, string | undefined> => ({
  SAMO_ENV: "prod",
  SESSION_SECRET: "real-session-secret-0123456789abcdef0123456789",
  MAGIC_LINK_SECRET: "real-magic-secret-0123456789abcdef0123456789",
  TOKEN_SECRET: "real-token-secret-0123456789abcdef0123456789",
});

const SIGNING_KEYS = ["SESSION_SECRET", "MAGIC_LINK_SECRET", "TOKEN_SECRET"] as const;

describe("resolveSamoEnv — default prod (fail-safe)", () => {
  it("defaults to prod when SAMO_ENV is absent", () => {
    expect(resolveSamoEnv({})).toBe("prod");
  });
  it("is dev ONLY for the exact value 'dev'", () => {
    expect(resolveSamoEnv({ SAMO_ENV: "dev" })).toBe("dev");
    expect(resolveSamoEnv({ SAMO_ENV: "development" })).toBe("prod");
    expect(resolveSamoEnv({ SAMO_ENV: "prod" })).toBe("prod");
    expect(resolveSamoEnv({ SAMO_ENV: "" })).toBe("prod");
  });
  it("is 'preview' for the exact value 'preview' (prod-mode, distinguishable)", () => {
    expect(resolveSamoEnv({ SAMO_ENV: "preview" })).toBe("preview");
  });
});

describe("resolveMagicLinkBaseUrl — per-env callback base (#190)", () => {
  const PROD = "https://samograph.samo.team";
  const PREVIEW = "https://samograph-somebranch.samo.cat";
  const DEFAULT = "https://samograph.dev";

  it("prefers BASE_URL when it is set and non-empty (preview → its own host)", () => {
    // samohost preview: BASE_URL = the env's own host, WEB_ORIGIN = prod.
    expect(resolveMagicLinkBaseUrl({ BASE_URL: PREVIEW, WEB_ORIGIN: PROD }, DEFAULT)).toBe(PREVIEW);
  });

  it("trims surrounding whitespace on BASE_URL", () => {
    expect(resolveMagicLinkBaseUrl({ BASE_URL: `  ${PREVIEW}  `, WEB_ORIGIN: PROD }, DEFAULT)).toBe(
      PREVIEW,
    );
  });

  it("falls back to WEB_ORIGIN when BASE_URL is empty or whitespace-only", () => {
    expect(resolveMagicLinkBaseUrl({ BASE_URL: "", WEB_ORIGIN: PROD }, DEFAULT)).toBe(PROD);
    expect(resolveMagicLinkBaseUrl({ BASE_URL: "   ", WEB_ORIGIN: PROD }, DEFAULT)).toBe(PROD);
  });

  it("falls back to WEB_ORIGIN when BASE_URL is absent (prod unchanged)", () => {
    expect(resolveMagicLinkBaseUrl({ WEB_ORIGIN: PROD }, DEFAULT)).toBe(PROD);
  });

  it("falls back to the entrypoint default when neither BASE_URL nor WEB_ORIGIN is set", () => {
    expect(resolveMagicLinkBaseUrl({}, DEFAULT)).toBe(DEFAULT);
  });
});

describe("assertNoDevDefaultSecrets — prod fail-closed (#64)", () => {
  it("passes when all three signing secrets are real", () => {
    expect(() => assertNoDevDefaultSecrets(goodProd())).not.toThrow();
  });

  for (const key of SIGNING_KEYS) {
    it(`throws in prod when ${key} is MISSING`, () => {
      const env = goodProd();
      delete env[key];
      expect(() => assertNoDevDefaultSecrets(env)).toThrow(new RegExp(key));
    });
    it(`throws in prod when ${key} equals its committed dev default`, () => {
      const env = { ...goodProd(), [key]: DEV_DEFAULT_SECRETS[key] };
      expect(() => assertNoDevDefaultSecrets(env)).toThrow(new RegExp(key));
    });
  }

  it("does NOT throw in dev even with the dev-default secrets", () => {
    expect(() =>
      assertNoDevDefaultSecrets({ SAMO_ENV: "dev", ...DEV_DEFAULT_SECRETS }),
    ).not.toThrow();
  });

  it("defaults to prod: absent SAMO_ENV + dev defaults still throws", () => {
    expect(() => assertNoDevDefaultSecrets({ ...DEV_DEFAULT_SECRETS })).toThrow();
  });

  it("throws in preview when a signing secret is dev-default (preview = prod-mode)", () => {
    const env = { ...goodProd(), SAMO_ENV: "preview" };
    expect(() => assertNoDevDefaultSecrets(env)).not.toThrow(); // real secrets → ok
    const withDevSecret = { ...env, SESSION_SECRET: DEV_DEFAULT_SECRETS.SESSION_SECRET };
    expect(() => assertNoDevDefaultSecrets(withDevSecret)).toThrow(/SESSION_SECRET/);
  });
});

describe("usingDevDefaultSecrets — offending names", () => {
  it("returns [] when all secrets are real", () => {
    expect(usingDevDefaultSecrets(goodProd())).toEqual([]);
  });
  it("names exactly the missing/dev-default secret", () => {
    expect(
      usingDevDefaultSecrets({ ...goodProd(), TOKEN_SECRET: DEV_DEFAULT_SECRETS.TOKEN_SECRET }),
    ).toEqual(["TOKEN_SECRET"]);
    const missing = goodProd();
    delete missing.SESSION_SECRET;
    expect(usingDevDefaultSecrets(missing)).toEqual(["SESSION_SECRET"]);
  });
});

describe("per-service secret lists — each service checks only what it uses", () => {
  it("APP_API list is all three; WS_HUB list is SESSION + TOKEN only (no MAGIC_LINK)", () => {
    expect([...APP_API_SIGNING_SECRETS]).toEqual([
      "SESSION_SECRET",
      "MAGIC_LINK_SECRET",
      "TOKEN_SECRET",
    ]);
    expect([...WS_HUB_SIGNING_SECRETS]).toEqual(["SESSION_SECRET", "TOKEN_SECRET"]);
    expect(WS_HUB_SIGNING_SECRETS).not.toContain("MAGIC_LINK_SECRET");
  });

  describe("app-api guard (APP_API_SIGNING_SECRETS) — magic link IS required", () => {
    it("THROWS on a dev-default MAGIC_LINK_SECRET", () => {
      const env = { ...goodProd(), MAGIC_LINK_SECRET: DEV_DEFAULT_SECRETS.MAGIC_LINK_SECRET };
      expect(() => assertNoDevDefaultSecrets(env, APP_API_SIGNING_SECRETS)).toThrow(
        /MAGIC_LINK_SECRET/,
      );
    });
    it("THROWS on a MISSING MAGIC_LINK_SECRET", () => {
      const env = goodProd();
      delete env.MAGIC_LINK_SECRET;
      expect(() => assertNoDevDefaultSecrets(env, APP_API_SIGNING_SECRETS)).toThrow(
        /MAGIC_LINK_SECRET/,
      );
    });
  });

  describe("ws-hub guard (WS_HUB_SIGNING_SECRETS) — magic link is IGNORED", () => {
    it("does NOT throw on a dev-default MAGIC_LINK_SECRET (ws-hub never uses it)", () => {
      const env = { ...goodProd(), MAGIC_LINK_SECRET: DEV_DEFAULT_SECRETS.MAGIC_LINK_SECRET };
      expect(() => assertNoDevDefaultSecrets(env, WS_HUB_SIGNING_SECRETS)).not.toThrow();
    });
    it("does NOT throw on a MISSING MAGIC_LINK_SECRET", () => {
      const env = goodProd();
      delete env.MAGIC_LINK_SECRET;
      expect(() => assertNoDevDefaultSecrets(env, WS_HUB_SIGNING_SECRETS)).not.toThrow();
    });
    it("STILL throws on a dev-default SESSION_SECRET", () => {
      const env = { ...goodProd(), SESSION_SECRET: DEV_DEFAULT_SECRETS.SESSION_SECRET };
      expect(() => assertNoDevDefaultSecrets(env, WS_HUB_SIGNING_SECRETS)).toThrow(
        /SESSION_SECRET/,
      );
    });
    it("STILL throws on a MISSING TOKEN_SECRET", () => {
      const env = goodProd();
      delete env.TOKEN_SECRET;
      expect(() => assertNoDevDefaultSecrets(env, WS_HUB_SIGNING_SECRETS)).toThrow(/TOKEN_SECRET/);
    });
    it("reports ONLY the ws-hub secrets, never MAGIC_LINK_SECRET, even when all three are bad", () => {
      const env = { ...goodProd(), ...DEV_DEFAULT_SECRETS };
      expect(usingDevDefaultSecrets(env, WS_HUB_SIGNING_SECRETS)).toEqual([
        "SESSION_SECRET",
        "TOKEN_SECRET",
      ]);
    });
  });
});
