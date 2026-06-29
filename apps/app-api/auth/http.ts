/**
 * HTTP adapter for the two magic-link routes (SPEC §5.1, §5.16).
 *
 * A thin, framework-free mapping from Request → Response over AuthService:
 *   POST /auth/magic-link {email}  → 200 (always, no account enumeration), or
 *                                    429 + Retry-After + SAMO-AUTH-004 body.
 *   GET  /auth/callback?token=…    → 200 + Set-Cookie session on success;
 *                                    401 with NO body on any failure.
 * The client IP is taken from X-Forwarded-For's first hop (the edge/tunnel sets
 * it) for the per-IP rate limit.
 */
import type { AuthService } from "./service.ts";

/** Extract the caller IP for rate limiting (X-Forwarded-For first hop). */
export function clientIp(_req: Request): string {
  throw new Error("not implemented: clientIp");
}

/** Build the Request→Response handler for /auth/magic-link and /auth/callback. */
export function createAuthHandler(
  _service: AuthService,
): (req: Request) => Promise<Response> {
  throw new Error("not implemented: createAuthHandler");
}
