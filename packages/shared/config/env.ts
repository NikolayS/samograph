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

/**
 * The signing secrets each live prod service actually USES — the guard checks
 * only these so a service never crash-loops over a secret it never reads.
 *
 * - `app-api` (`apps/app-api/server.ts`) mints magic links AND verifies
 *   sessions AND mints share/capability tokens → all three.
 * - `ws-hub` (`apps/ws-hub/dev-live-server.ts`) verifies the session cookie and
 *   verifies share/capability tokens, but does NOT touch magic links →
 *   `SESSION_SECRET` + `TOKEN_SECRET` only. Requiring `MAGIC_LINK_SECRET` in the
 *   ws-hub (samograph-live) env would be an over-reach that crash-loops ws-hub
 *   on deploy when that secret is absent from its env.
 */
export const APP_API_SIGNING_SECRETS: readonly SigningSecretName[] = SIGNING_SECRET_NAMES;
export const WS_HUB_SIGNING_SECRETS: readonly SigningSecretName[] = ["SESSION_SECRET", "TOKEN_SECRET"];

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
 *
 * `secretNames` scopes the check to the secrets the calling service actually
 * uses (see {@link APP_API_SIGNING_SECRETS} / {@link WS_HUB_SIGNING_SECRETS});
 * it defaults to all three (fail-safe: a caller that forgets checks MORE, never
 * fewer). Order follows `secretNames` so the message is deterministic.
 */
export function usingDevDefaultSecrets(
  env: EnvLike,
  secretNames: readonly SigningSecretName[] = SIGNING_SECRET_NAMES,
): SigningSecretName[] {
  const offending: SigningSecretName[] = [];
  for (const name of secretNames) {
    const value = env[name];
    if (!value || value === DEV_DEFAULT_SECRETS[name]) offending.push(name);
  }
  return offending;
}

/**
 * Prod fail-closed guard: in prod, THROW (→ non-zero exit) when any signing
 * secret the service USES is missing or a committed dev default. In dev, a
 * no-op (the caller warns instead), so `scripts/dev-local.sh` — which
 * intentionally uses the dev defaults — still runs.
 *
 * `secretNames` is the explicit list of secrets the caller depends on; each
 * service passes only the ones it reads (see {@link APP_API_SIGNING_SECRETS} /
 * {@link WS_HUB_SIGNING_SECRETS}) so, e.g., the ws-hub never crash-loops over a
 * `MAGIC_LINK_SECRET` it never uses. Defaults to all three (fail-safe).
 */
export function assertNoDevDefaultSecrets(
  env: EnvLike,
  secretNames: readonly SigningSecretName[] = SIGNING_SECRET_NAMES,
): void {
  if (resolveSamoEnv(env) !== "prod") return;
  const offending = usingDevDefaultSecrets(env, secretNames);
  if (offending.length > 0) {
    throw new Error(
      `[fail-closed] refusing to boot with SAMO_ENV=prod: ${offending.join(", ")} ` +
        `must be set to a real secret — each is missing or still equal to its committed, ` +
        `PUBLIC dev-default literal. Set real values in the secret manager/env, or run ` +
        `locally with SAMO_ENV=dev.`,
    );
  }
}
