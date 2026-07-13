import { resolveSamoEnv, type EnvLike } from "../../packages/shared/config/env.ts";

/** The unauthenticated transcript injector exists only in explicit local dev. */
export function shouldStartDevControl(env: EnvLike): boolean {
  return resolveSamoEnv(env) === "dev";
}
