/**
 * @samograph/ingest — Bun/Hono HTTP service (SPEC §4.1).
 *
 * POST /webhook (Recall signature + ingest_secret verify), normalizer, Postgres
 * persistence, fan-out publish, and the leader-elected tunnel watchdog land in
 * the call-path Sprint-2 issues. This foundation stub is a Bun-native request
 * handler whose GET /health echoes the `samograph-health` marker so a regional
 * cloudflared named tunnel can pass the `/health` round-trip (§4.5, §8 exit).
 */
import { HEALTH_MARKER } from "../../src/server.ts";

export const SERVICE_NAME = "ingest";

export function handler(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    // Same nonce + marker contract the CLI's `src/server.ts` /health uses, so the
    // §4.5 tunnel watchdog's `probeTunnelHealth` round-trip works unchanged and a
    // tunnel interstitial/error page can never pass as a healthy response.
    return Response.json({
      ok: true,
      nonce: url.searchParams.get("nonce") ?? "",
      marker: HEALTH_MARKER,
    });
  }
  return new Response("not found", { status: 404 });
}
