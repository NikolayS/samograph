/**
 * @samograph/ws-hub — Bun/Hono HTTP + WS service (SPEC §4.1).
 *
 * /calls/:id/stream live transcript fan-out with bounded per-connection queues,
 * backpressure, gap frames, and ?since_seq replay (§6.2 #3) lands in the backend
 * Sprint-2 issue. This foundation stub is a Bun-native request handler with a
 * /health endpoint so the workspace seam exists and is exercised by CI.
 */
export const SERVICE_NAME = "ws-hub";

export function handler(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok", { status: 200 });
  return new Response("not found", { status: 404 });
}
