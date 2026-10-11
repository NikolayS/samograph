/**
 * Worker registration core (SPEC §5.8, §4.2, §6.2 #9) — no DB.
 *
 * On start the worker generates a per-instance secret and persists ONLY its
 * SHA-256 hash (never the plaintext) into `workers`, mirroring how the
 * orchestrator persists `ingest_secret_hash` (§4.2). These unit tests pin the
 * crypto + the "hash, never plaintext" write contract (#6) against a spy store;
 * the Postgres-backed `pgWorkerStore` (insert + heartbeat) is exercised in the
 * DB-gated suite.
 */
import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  generateWorkerSecret,
  hashWorkerSecret,
  registerWorker,
  type WorkerStore,
  type WorkerRegistration,
} from "./registry.ts";

const CALL_ID = "33333333-3333-3333-3333-333333333333";

/** In-memory spy store: captures exactly what would be written to `workers`. */
function spyStore() {
  const writes: WorkerRegistration[] = [];
  const heartbeats: string[] = [];
  const store: WorkerStore = {
    async register(rec) {
      writes.push(rec);
    },
    async heartbeat(callId) {
      heartbeats.push(callId);
    },
  };
  return { writes, heartbeats, store };
}

describe("worker registration core (§5.8 / §4.2 / §6.2 #9)", () => {
  it("hashWorkerSecret is the SHA-256 hex of the secret (never the plaintext)", () => {
    const secret = "per-instance-secret-xyz";
    const expected = createHash("sha256").update(secret).digest("hex");
    expect(hashWorkerSecret(secret)).toBe(expected);
    expect(hashWorkerSecret(secret)).not.toBe(secret);
    expect(hashWorkerSecret(secret)).toHaveLength(64);
  });

  it("generateWorkerSecret yields a fresh, non-trivial secret each call", () => {
    const a = generateWorkerSecret();
    const b = generateWorkerSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  // ── #6: registration writes the HASH, never the plaintext secret ───────────
  it("registerWorker persists host/port + the secret HASH, never the plaintext", async () => {
    const { writes, store } = spyStore();
    const secret = "register-me-plaintext-secret-0001";
    const expectedHash = createHash("sha256").update(secret).digest("hex");

    const result = await registerWorker(store, {
      callId: CALL_ID,
      host: "10.0.0.7",
      port: 41999,
      secret,
    });

    expect(writes).toHaveLength(1);
    const w = writes[0];
    expect(w.callId).toBe(CALL_ID);
    expect(w.host).toBe("10.0.0.7");
    expect(w.port).toBe(41999);
    expect(w.secretHash).toBe(expectedHash);
    // The plaintext secret must NEVER be handed to the store.
    expect(JSON.stringify(w)).not.toContain(secret);
    // The function returns the hash it persisted (for the caller's logs/handoff).
    expect(result.secretHash).toBe(expectedHash);
  });

  it("registerWorker → heartbeat advances via the same store seam", async () => {
    const { heartbeats, store } = spyStore();
    await registerWorker(store, { callId: CALL_ID, host: "h", port: 1, secret: "s" });
    await store.heartbeat(CALL_ID);
    expect(heartbeats).toEqual([CALL_ID]);
  });
});
