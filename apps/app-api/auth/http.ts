/**
 * HTTP adapter for the two magic-link routes (SPEC §5.1, §5.16).
 *
 * A thin, framework-free mapping from Request → Response over AuthService:
 *   POST /auth/magic-link {email}  → 200 (always, no account enumeration), or
 *                                    429 + Retry-After + SAMO-AUTH-004 body.
 *   GET  /auth/callback?token=…    → 200 + Set-Cookie session on success;
 *                                    401 with NO body on any failure.
 *   POST /auth/logout              → 204 + Set-Cookie clearing the session.
 * The client IP for the per-IP rate limit is derived from a TRUSTED source:
 * Cloudflare's `cf-connecting-ip` when present (it is set by the edge and cannot
 * be forged by the client), falling back to the leftmost `X-Forwarded-For` hop
 * only when it is absent. See docs/runbooks/trusted-proxy.md for the deployment
 * invariant this depends on.
 */
import type { AuthService } from "./service.ts";
import { AUTH_ERRORS } from "./errors.ts";
import { buildClearedSessionCookie } from "./session.ts";

/**
 * Extract the caller IP for the per-IP magic-link rate limit (SPEC §5.1).
 *
 * SECURITY: derive the key from a TRUSTED source. Cloudflare (the v1 edge)
 * APPENDS to `X-Forwarded-For`, so the leftmost XFF hop is fully
 * client-controlled — an attacker rotating a forged `X-Forwarded-For` per
 * request would mint a distinct limiter bucket each time and bypass the 20/hr
 * per-IP cap (email-bombing / Resend cost abuse). `cf-connecting-ip` is set by
 * the trusted edge and cannot be forged by the client, so it is preferred; the
 * leftmost XFF hop is treated as UNTRUSTED and used only as a fallback when
 * `cf-connecting-ip` is absent. Prod MUST sit behind a trusted edge that sets
 * `cf-connecting-ip` (or overwrites XFF) — see docs/runbooks/trusted-proxy.md.
 */
export function clientIp(req: Request): string {
  const direct = req.headers.get("cf-connecting-ip");
  if (direct) {
    const trimmed = direct.trim();
    if (trimmed) return trimmed;
  }
  // Fallback only: the leftmost X-Forwarded-For hop is UNTRUSTED behind an
  // appending edge (docs/runbooks/trusted-proxy.md).
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/** Build the Request→Response handler for /auth/magic-link and /auth/callback. */
export function createAuthHandler(
  service: AuthService,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/auth/magic-link") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      const email = (body as { email?: unknown } | null)?.email;
      if (typeof email !== "string" || email.trim().length === 0) {
        return Response.json({ error: "email is required" }, { status: 400 });
      }

      const result = await service.requestMagicLink({ email, ip: clientIp(req) });
      if (result.ok) {
        // Always 200 regardless of whether the account exists (no enumeration).
        return Response.json({ ok: true }, { status: 200 });
      }
      const info = AUTH_ERRORS[result.code];
      return new Response(
        JSON.stringify({ code: info.code, message: info.message, retryable: info.retryable }),
        {
          status: info.httpStatus,
          headers: {
            "content-type": "application/json",
            "retry-after": String(result.retryAfterSec),
          },
        },
      );
    }

    if (req.method === "GET" && url.pathname === "/auth/callback") {
      const token = url.searchParams.get("token");
      // Missing token and any verification failure both return 401 with NO body
      // (no leak of which check failed — SPEC §5.1).
      if (!token) return new Response(null, { status: 401 });
      const result = await service.callback(token);
      if (!result.ok) return new Response(null, { status: result.status });
      return new Response(null, {
        status: 200,
        headers: { "set-cookie": result.setCookie! },
      });
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
      // Stateless HMAC sessions carry no server-side record to revoke, so logout
      // is purely "clear the cookie". Unconditional (idempotent): a missing or
      // already-invalid cookie still returns the same cleared Set-Cookie + 204.
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": buildClearedSessionCookie() },
      });
    }

    return new Response("not found", { status: 404 });
  };
}
