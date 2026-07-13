import { resolveSamoEnv, type EnvLike } from "../../packages/shared/config/env.ts";
import type { EmailSender, MagicLinkEmail } from "./auth/index.ts";

const PROD_WEB_ORIGIN = "https://samograph.dev";

function exactHttpsOrigin(raw: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${field} must be an exact HTTPS origin with no credentials, path, query, or fragment`);
  }
  return url.origin;
}

/** Resolve magic-link callbacks without ever defaulting a preview to prod. */
export function resolveHostedWebOrigin(env: EnvLike): string {
  if (resolveSamoEnv(env) === "preview") {
    if (env.WEB_ORIGIN?.trim()) {
      throw new Error(
        "SAMO_ENV=preview must not inherit WEB_ORIGIN; use samohost's generated BASE_URL",
      );
    }
    const generated = env.BASE_URL?.trim();
    if (!generated) {
      throw new Error(
        "SAMO_ENV=preview requires samohost's generated BASE_URL; refusing to point magic links at production",
      );
    }
    const origin = exactHttpsOrigin(generated, "BASE_URL");
    if (origin === PROD_WEB_ORIGIN || origin === "https://samograph.samo.team") {
      throw new Error("preview BASE_URL resolves to a production origin; refusing startup");
    }
    return origin;
  }

  const explicit = env.WEB_ORIGIN?.trim();
  if (explicit) return exactHttpsOrigin(explicit, "WEB_ORIGIN");

  return PROD_WEB_ORIGIN;
}

/**
 * Preview-only delivery sink. Links are visible to operators in the isolated
 * preview unit's journal, not exposed through an unauthenticated HTTP endpoint.
 */
export function previewJournalEmailSender(
  log: (message: string) => void = (message) => console.info(message),
): EmailSender {
  return {
    async sendMagicLink(email: MagicLinkEmail): Promise<void> {
      log(`[preview-auth] magic link for ${email.to}: ${email.link}`);
    },
  };
}
