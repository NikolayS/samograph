/**
 * @samograph/ws-hub — Bun/Hono HTTP + WS service (SPEC §4.1).
 *
 * The transport-agnostic fan-out CORE — per-`call_id` pub/sub, a bounded
 * per-subscriber outbound queue (256 msgs / 512 KB), drop-oldest + a single
 * gap frame (§5.5, §6.2 #3, §5.11) — lives in ./hub.ts and is re-exported
 * below. Wiring it onto the `/calls/:id/stream` WS upgrade + authorizeCall +
 * `?since_seq` replay is the WS-upgrade issue; this entrypoint still exposes a
 * Bun-native request handler with a /health endpoint exercised by CI.
 */
export {
  Hub,
  Subscriber,
  frameBytes,
  MAX_QUEUE_MESSAGES,
  MAX_QUEUE_BYTES,
  type DataFrame,
  type GapFrame,
  type OutboundFrame,
} from "./hub.ts";

export const SERVICE_NAME = "ws-hub";

export function handler(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok", { status: 200 });
  return new Response("not found", { status: 404 });
}
