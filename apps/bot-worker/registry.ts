/**
 * Worker registration / service discovery (SPEC §5.8, §4.2, §6.2 #9).
 *
 * On start a bot-worker generates a per-instance secret and writes
 * `(call_id, host, port, worker_secret_hash, registered_at, last_heartbeat_at)`
 * to the `workers` table (PK `call_id`). app-api (v1) and agent-gateway (v2)
 * then resolve the worker by `call_id` (RLS-scoped to the call's tenant — see
 * `apps/app-api/workers/discovery.ts`) and authenticate the inter-service call
 * with the per-instance secret in an `Authorization: Bearer` header.
 *
 * The plaintext secret is the same value app-api presents as the Bearer; ONLY
 * its SHA-256 hash is ever persisted (mirroring how the orchestrator stores
 * `ingest_secret_hash`, §4.2) so a `workers`-table read never yields a usable
 * credential. The {@link WorkerStore} port keeps the core unit-testable; the
 * Postgres binding is {@link pgWorkerStore}.
 */
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../packages/shared/crypto.ts";
import type { SQL } from "bun";

/**
 * Mint a per-instance worker secret: 32 cryptographically-random bytes (256 bits)
 * as an unpadded base64url string. Unique per worker process (§5.8).
 */
export function generateWorkerSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 (hex) of the worker secret — the only form ever persisted (§4.2, §5.8). */
export function hashWorkerSecret(secret: string): string {
  return sha256Hex(secret);
}

/** The exact row written to `workers` — note: the HASH, never the plaintext. */
export interface WorkerRegistration {
  callId: string;
  host: string;
  port: number;
  secretHash: string;
}

/** Inputs to register a worker: the plaintext secret is hashed before any write. */
export interface RegisterWorkerInput {
  callId: string;
  host: string;
  port: number;
  /** Plaintext per-instance secret. NEVER persisted — only its hash is stored. */
  secret: string;
}

/**
 * Persistence port for the `workers` table. Abstract so registration is testable
 * without a database; the Postgres implementation is {@link pgWorkerStore}.
 */
export interface WorkerStore {
  /** Upsert the worker's `(call_id, host, port, worker_secret_hash)` row. */
  register(reg: WorkerRegistration): Promise<void>;
  /** Advance `last_heartbeat_at` for the call's worker (liveness signal). */
  heartbeat(callId: string): Promise<void>;
}

/**
 * Register a worker: hash the plaintext secret and persist the hash-only row.
 * Returns the persisted hash (for the caller's structured logs / secret handoff);
 * the plaintext NEVER touches the store.
 */
export async function registerWorker(
  store: WorkerStore,
  input: RegisterWorkerInput,
): Promise<{ secretHash: string }> {
  const secretHash = hashWorkerSecret(input.secret);
  await store.register({
    callId: input.callId,
    host: input.host,
    port: input.port,
    secretHash,
  });
  return { secretHash };
}

/**
 * Postgres-backed {@link WorkerStore} over `@samograph/shared/db`. The upsert is
 * keyed on the PK `call_id`, so a restarted worker re-registering its new
 * host:port + secret cleanly replaces the stale row.
 */
export function pgWorkerStore(sql: SQL): WorkerStore {
  return {
    async register({ callId, host, port, secretHash }) {
      await sql`
        INSERT INTO workers (call_id, host, port, worker_secret_hash, registered_at, last_heartbeat_at)
        VALUES (${callId}, ${host}, ${port}, ${secretHash}, now(), now())
        ON CONFLICT (call_id) DO UPDATE SET
          host = EXCLUDED.host,
          port = EXCLUDED.port,
          worker_secret_hash = EXCLUDED.worker_secret_hash,
          registered_at = now(),
          last_heartbeat_at = now()`;
    },
    async heartbeat(callId) {
      await sql`UPDATE workers SET last_heartbeat_at = now() WHERE call_id = ${callId}`;
    },
  };
}
