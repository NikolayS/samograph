/**
 * HTTP adapter for the `/settings` surface (SPEC §5.12).
 *
 * `GET /settings` returns the caller's per-tenant settings (the §5.12 defaults
 * when none are saved yet) plus the option catalog the UI renders its selects
 * from. `PUT /settings` validates + upserts a full settings document. Both routes
 * are OWNER-ONLY (magic-link session cookie) and RLS-scoped to the caller's
 * tenant via the store's `SET LOCAL ROLE samograph_app` transactions (§5.10).
 */
import type { SQL } from "bun";
import { verifySession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import {
  parseSettingsBody,
  settingsOptions,
  toWire,
} from "../../../packages/shared/settings/index.ts";
import { readTenantSettings, writeTenantSettings } from "./store.ts";

/** §5.16-style code for a rejected settings document. */
export const SETTINGS_INVALID_CODE = "SAMO-SETTINGS-INVALID" as const;

export interface SettingsHandlerDeps {
  /** Privileged connection (login role able to `SET ROLE samograph_app`). */
  sql: SQL;
  /** HMAC secret the session cookie was signed with (§5.1). */
  sessionSecret: string;
  /** Epoch-ms clock; defaults to the wall clock. */
  now?: () => number;
}

/** Read a named cookie from the request's `Cookie` header. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function unauthenticated(): Response {
  return new Response(null, { status: 401 });
}

/** Build the Request→Response handler for `/settings`. */
export function createSettingsHandler(
  deps: SettingsHandlerDeps,
): (req: Request) => Promise<Response> {
  const { sql, sessionSecret } = deps;
  const nowMs = (): number => (deps.now ? deps.now() : Date.now());

  /** Privileged pre-tenant existence check (mirrors calls/http.ts, #114). */
  const tenantExists = async (tenantId: string): Promise<boolean> => {
    const rows = (await sql`SELECT 1 AS ok FROM tenants WHERE id = ${tenantId}`) as unknown as unknown[];
    return rows.length > 0;
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== "/settings") return new Response("not found", { status: 404 });

    // Owner authentication: the magic-link session cookie (pure HMAC — no DB).
    const cookie = readCookie(req, SESSION_COOKIE_NAME);
    const claims = cookie ? verifySession(cookie, sessionSecret, nowMs()) : null;
    if (!claims) return unauthenticated();
    // A signed cookie can outlive its tenant (#114): a stale-tenant session → 401.
    if (!(await tenantExists(claims.tenantId))) return unauthenticated();

    if (req.method === "GET") {
      const settings = await readTenantSettings(sql, claims.tenantId);
      return Response.json(
        { settings: toWire(settings), options: settingsOptions() },
        { status: 200 },
      );
    }

    if (req.method === "PUT") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      const parsed = parseSettingsBody(body);
      if (!parsed.ok) {
        return new Response(
          JSON.stringify({ code: SETTINGS_INVALID_CODE, message: parsed.message, retryable: false }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const saved = await writeTenantSettings(sql, claims.tenantId, parsed.value);
      return Response.json(
        { settings: toWire(saved), options: settingsOptions() },
        { status: 200 },
      );
    }

    return new Response(null, { status: 405 });
  };
}
