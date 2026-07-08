/**
 * Shared startup config: the SAMO_ENV gate and the prod fail-closed secret guard
 * (issue #64). Both live prod entrypoints — `apps/app-api/server.ts` and
 * `apps/ws-hub/dev-live-server.ts` — call {@link assertNoDevDefaultSecrets}
 * BEFORE they bind a port, so a prod box that is missing a real signing secret
 * (or is still carrying a committed dev-default literal) refuses to boot instead
 * of silently signing sessions/tokens with a public key.
 *
 * The gate is deliberately fail-safe: SAMO_ENV defaults to `prod` (absence =
 * prod), so forgetting to set it hardens rather than weakens. Only the exact
 * value `dev` opts into the dev shortcuts (dev-default secrets, plain-HTTP
 * cookies) that `scripts/dev-local.sh` relies on. The gate is resolved from an
 * explicit env flag, NOT the request host, which is spoofable behind a proxy's
 * `X-Forwarded-Host`.
 */

/** Runtime mode. Absence resolves to `prod` (fail-safe). */
export type SamoEnv = "dev" | "prod";

/**
 * The committed, PUBLIC dev-default literals. These live in the repo on purpose
 * (so `dev-local.sh` needs no secret manager) and are therefore NOT secret — in
 * prod each MUST be overridden with a real value or the process refuses to boot.
 */
export const DEV_DEFAULT_SECRETS: Readonly<Record<SigningSecretName, string>> = Object.freeze({
  SESSION_SECRET: "dev-only-session-secret-change-me",
  MAGIC_LINK_SECRET: "dev-only-magic-link-secret-change-me",
  TOKEN_SECRET: "dev-only-token-secret-change-me-abcd",
});

/** The three HMAC signing secrets guarded in prod. */
export type SigningSecretName = "SESSION_SECRET" | "MAGIC_LINK_SECRET" | "TOKEN_SECRET";

const SIGNING_SECRET_NAMES: readonly SigningSecretName[] = [
  "SESSION_SECRET",
  "MAGIC_LINK_SECRET",
  "TOKEN_SECRET",
];

/** Minimal env shape (a subset of `process.env`). */
export type EnvLike = Record<string, string | undefined>;

/** Resolve SAMO_ENV once; only the exact string `dev` is dev, everything else is prod. */
export function resolveSamoEnv(env: EnvLike): SamoEnv {
  return env.SAMO_ENV === "dev" ? "dev" : "prod";
}

/**
 * Names of the signing secrets that are MISSING or still equal to their
 * committed dev-default literal, in a stable order. `[]` means all are real.
 * Used by BOTH the prod fail-closed throw and the dev `usingDevSecrets` warn.
 */
export function usingDevDefaultSecrets(env: EnvLike): SigningSecretName[] {
  const offending: SigningSecretName[] = [];
  for (const name of SIGNING_SECRET_NAMES) {
    const value = env[name];
    if (!value || value === DEV_DEFAULT_SECRETS[name]) offending.push(name);
  }
  return offending;
}

/**
 * Prod fail-closed guard: in prod, THROW (→ non-zero exit) when any signing
 * secret is missing or a committed dev default. In dev, a no-op (the caller
 * warns instead), so `scripts/dev-local.sh` — which intentionally uses the dev
 * defaults — still runs.
 */
export function assertNoDevDefaultSecrets(env: EnvLike): void {
  if (resolveSamoEnv(env) !== "prod") return;
  const offending = usingDevDefaultSecrets(env);
  if (offending.length > 0) {
    throw new Error(
      `[fail-closed] refusing to boot with SAMO_ENV=prod: ${offending.join(", ")} ` +
        `must be set to a real secret — each is missing or still equal to its committed, ` +
        `PUBLIC dev-default literal. Set real values in the secret manager/env, or run ` +
        `locally with SAMO_ENV=dev.`,
    );
  }
}
