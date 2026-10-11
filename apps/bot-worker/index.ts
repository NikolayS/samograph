/**
 * @samograph/bot-worker — Bun-native process-per-call HTTP service (SPEC §4.1, §5.8).
 *
 * Ships two things (the v1 seam the v2 AI-agent channel reuses):
 *   - the command/act surface (chat/presence/frames/frame/leave) bound to one
 *     registered `host:port` and authenticated with a per-instance Bearer secret
 *     ({@link createWorkerHandler}, see `./worker.ts`); and
 *   - worker registration / service discovery into the `workers` table
 *     ({@link registerWorker} / {@link pgWorkerStore}, see `./registry.ts`).
 *
 * `handler` remains the unauthenticated `/health` liveness stub CI exercises.
 */
export const SERVICE_NAME = "bot-worker";

export function handler(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok", { status: 200 });
  return new Response("not found", { status: 404 });
}

export {
  createWorkerHandler,
  inMemoryPresenceStore,
  inMemoryFrameStore,
  type CreateWorkerHandlerDeps,
  type WorkerRecallPort,
  type WorkerPresenceStore,
  type WorkerFrameStore,
  type WorkerFrame,
} from "./worker.ts";

export {
  generateWorkerSecret,
  hashWorkerSecret,
  registerWorker,
  pgWorkerStore,
  type WorkerStore,
  type WorkerRegistration,
  type RegisterWorkerInput,
} from "./registry.ts";
