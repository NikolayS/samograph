/**
 * Worker discovery + invocation (SPEC §5.8, §6.2 #9, §5.16) — the "same code
 * path" v1 app-api and v2 agent-gateway use to reach a per-call bot-worker.
 *
 * Flow, in this exact order (the security contract):
 *   1. {@link authorizeCall} (the tenancy gate, §5.6) runs FIRST. A denied caller
 *      gets a single bodyless 403 and the worker is never resolved or contacted —
 *      so a leaked worker secret used cross-tenant is stopped here (§6.2 #9.4),
 *      BEFORE any inter-service Bearer is presented.
 *   2. {@link resolveWorker} reads `workers` under the now-established tenant
 *      context, so RLS scopes discovery to the call's tenant (§6.2 #9.1).
 *   3. {@link callWorker} performs the inter-service call with the per-instance
 *      secret in `Authorization: Bearer`, BOUNDED by `AbortSignal.timeout`. A
 *      dead/stale worker (refused connection or a never-answering process) is
 *      caught and surfaced as a clean, retryable `SAMO-WORKER-503` — never a hang
 *      (§6.2 #9.2). Transcript ingest is a separate path and keeps flowing.
 *
 * Each collaborator is injectable so the gate-first ordering and the 503 bound
 * are unit-testable without a database or real sockets; the defaults are the real
 * gate / RLS read / fetch, exercised end-to-end in the DB-gated suite.
 */
import type { SQL } from "bun";
import {
  authorizeCall,
  type AuthorizeDeps,
  type AuthorizeResult,
} from "../../../packages/shared/auth/index.ts";
import { WORKER_UNAVAILABLE, workerErrorResponse } from "./errors.ts";

export { WORKER_UNAVAILABLE } from "./errors.ts";
export type { AuthorizeDeps, AuthorizeResult } from "../../../packages/shared/auth/index.ts";

/** Injectable fetch (the real `fetch` in prod; a fake in tests). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** A worker resolved from the `workers` table (no secret — that is provided out-of-band). */
export interface ResolvedWorker {
  callId: string;
  host: string;
  port: number;
}

/** One command/act call to forward to a worker verb. */
export interface WorkerCall {
  method: string;
  /** One of the §5.8 verbs: `chat` | `presence` | `frames` | `frame` | `leave`. */
  verb: string;
  /** Query params (e.g. `frame?source=screen`). */
  query?: Record<string, string>;
  /** JSON body for `POST` verbs. */
  body?: unknown;
}

/** Default bound on an inter-service call (ms) — keeps a dead worker from hanging. */
export const DEFAULT_WORKER_TIMEOUT_MS = 2000;

export interface CallWorkerOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
}

/**
 * Resolve a worker by `call_id`. MUST run on a transaction whose tenant context
 * is already set (e.g. by the gate), so RLS scopes the `workers` read to the
 * call's tenant — a cross-tenant `call_id` yields no row (§6.2 #9.1).
 */
export async function resolveWorker(tx: SQL, callId: string): Promise<ResolvedWorker | null> {
  const rows = (await tx`
    SELECT call_id, host, port FROM workers WHERE call_id = ${callId}
  `) as unknown as Array<{ call_id: string; host: string; port: number }>;
  if (rows.length === 0) return null;
  return { callId: rows[0].call_id, host: rows[0].host, port: Number(rows[0].port) };
}

/** Build the worker verb URL: `http://<host>:<port>/v1/call/<callId>/<verb>[?query]`. */
function workerUrl(worker: ResolvedWorker, call: WorkerCall): string {
  const base = `http://${worker.host}:${worker.port}/v1/call/${encodeURIComponent(worker.callId)}/${call.verb}`;
  if (!call.query || Object.keys(call.query).length === 0) return base;
  return `${base}?${new URLSearchParams(call.query).toString()}`;
}

/**
 * Call a resolved worker with the per-instance secret as a Bearer, bounded by a
 * timeout. Any transport failure — refused connection, abort/timeout, DNS — is
 * caught and rendered as a clean `SAMO-WORKER-503` (never a hang; §6.2 #9.2).
 */
export async function callWorker(
  worker: ResolvedWorker,
  secret: string,
  call: WorkerCall,
  opts: CallWorkerOptions = {},
): Promise<Response> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchFn);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const init: RequestInit = {
    method: call.method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  };
  try {
    return await fetchFn(workerUrl(worker, call), init);
  } catch {
    // Refused / aborted / DNS — a dead or stale worker. Clean, bounded 503.
    return workerErrorResponse(WORKER_UNAVAILABLE);
  }
}

/** Inbound credentials for an act-channel invocation (mirrors the gate's inputs). */
export interface InvokeWorkerRequest {
  callId: string;
  sessionCookie?: string | null;
  shareToken?: string | null;
  agentToken?: string | null;
}

export interface InvokeWorkerDeps {
  /** Tenancy-gate collaborators (keyring + privileged session/call→tenant lookups). */
  gate: AuthorizeDeps;
  /** The per-instance worker secret app-api presents as the Bearer (secret-manager seam). */
  workerSecret: (callId: string) => string | Promise<string>;
  /** Authorize seam; defaults to the real {@link authorizeCall}. */
  authorize?: (tx: SQL, req: InvokeWorkerRequest, deps: AuthorizeDeps) => Promise<AuthorizeResult>;
  /** Resolve seam; defaults to the real {@link resolveWorker}. */
  resolve?: (tx: SQL, callId: string) => Promise<ResolvedWorker | null>;
  /** Call seam; defaults to the real {@link callWorker}. */
  call?: (
    worker: ResolvedWorker,
    secret: string,
    c: WorkerCall,
    opts: CallWorkerOptions,
  ) => Promise<Response>;
  fetch?: FetchFn;
  timeoutMs?: number;
}

/** The single bodyless 403 the tenancy gate renders on DENY (§5.6 / `SAMO-AUTHZ-001`). */
function denied(): Response {
  return new Response(null, { status: 403 });
}

/**
 * Authorize → resolve → call, in that order. The gate runs BEFORE the
 * inter-service auth; discovery + the worker call are reached only on a grant.
 */
export async function invokeWorker(
  tx: SQL,
  req: InvokeWorkerRequest,
  call: WorkerCall,
  deps: InvokeWorkerDeps,
): Promise<Response> {
  const authorize = deps.authorize ?? authorizeCall;
  const resolve = deps.resolve ?? resolveWorker;
  const doCall = deps.call ?? callWorker;

  // 1) Tenancy gate FIRST. Deny → 403, no worker resolution or contact.
  const authz = await authorize(tx, req, deps.gate);
  if (!authz.authorized) return denied();

  // 2) RLS-scoped discovery (the gate set the tenant context on `tx`).
  const worker = await resolve(tx, req.callId);
  if (!worker) return workerErrorResponse(WORKER_UNAVAILABLE);

  // 3) Bounded inter-service call with the per-instance Bearer secret.
  const secret = await deps.workerSecret(req.callId);
  return doCall(worker, secret, call, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
}
