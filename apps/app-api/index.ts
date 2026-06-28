/**
 * @samograph/app-api — Bun/Hono HTTP service (SPEC §4.1).
 *
 * Hono route wiring (/auth/magic-link, /auth/callback, /calls, /calls/:id/share)
 * + business logic land in the app-api Sprint-1 issue. This foundation stub is a
 * Bun-native request handler with a /health endpoint so the workspace seam
 * exists and is exercised by CI.
 */
export const SERVICE_NAME = "app-api";

export function handler(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok", { status: 200 });
  return new Response("not found", { status: 404 });
}
