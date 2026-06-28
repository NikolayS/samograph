/**
 * @samograph/ingest — Bun/Hono HTTP service (SPEC §4.1).
 *
 * POST /webhook (Recall signature + ingest_secret verify), normalizer, Postgres
 * persistence, fan-out publish, and the leader-elected tunnel watchdog land in
 * the call-path Sprint-2 issues. This foundation stub is a Bun-native request
 * handler with a /health endpoint (the tunnel round-trip marker).
 */
export const SERVICE_NAME = "ingest";

export function handler(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok", { status: 200 });
  return new Response("not found", { status: 404 });
}
