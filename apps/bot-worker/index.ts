/**
 * @samograph/bot-worker — Bun/Hono HTTP service (SPEC §4.1).
 *
 * The process-per-call command/act surface (chat/frame/frames/presence/leave)
 * plus worker registration (§6.2 #9) land in the call-path Sprint-2 issue. This
 * foundation stub is a Bun-native request handler with a /health endpoint so the
 * workspace seam exists and is exercised by CI.
 */
export const SERVICE_NAME = "bot-worker";

export function handler(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok", { status: 200 });
  return new Response("not found", { status: 404 });
}
