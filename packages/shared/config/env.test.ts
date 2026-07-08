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
  DEV_DEFAULT_SECRETS,
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
