/**
 * Server-side state for magic-link auth: the outstanding-link store and the
 * user/tenant store (SPEC §5.1, §6.2 #6).
 *
 * Both are interfaces with in-memory fakes so the security suite runs with no
 * network. `InMemoryMagicLinkStore` enforces single-use (consume is atomic) and
 * supersession (issuing a new link for an email invalidates older outstanding
 * ones). A Postgres-backed `UserStore` adapter (pg-user-store.ts) implements the
 * real user+tenant creation against `packages/shared/db`.
 */
import { randomUUID } from "node:crypto";
import type { AuthUser, MagicLinkRecord } from "./types.ts";

/** Outcome of attempting to consume (single-use) a magic link by `jti`. */
export type ConsumeResult =
  | { outcome: "consumed"; record: MagicLinkRecord } // first valid use
  | { outcome: "already_consumed"; record: MagicLinkRecord } // replay
  | { outcome: "superseded"; record: MagicLinkRecord } // a newer link replaced it
  | { outcome: "not_found" };

export interface MagicLinkStore {
  /** Persist a freshly issued link, invalidating older outstanding links for the same email. */
  issue(record: MagicLinkRecord): Promise<void>;
  /** Atomically consume by `jti`; replay-safe and supersession-aware. */
  consume(jti: string): Promise<ConsumeResult>;
  /** Read a record by `jti` (test/inspection helper). */
  get(jti: string): Promise<MagicLinkRecord | undefined>;
}

export interface UserStore {
  /** Create (or load) the user for `email` and ensure their 1:1 tenant exists. */
  createOrLoadUser(email: string): Promise<AuthUser>;
}

/** Lower-case + trim so `User@X.com` and `user@x.com` are one identity. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class InMemoryMagicLinkStore implements MagicLinkStore {
  private readonly byJti = new Map<string, MagicLinkRecord>();
  private readonly outstandingByEmail = new Map<string, string>();

  async issue(record: MagicLinkRecord): Promise<void> {
    const email = normalizeEmail(record.email);
    // Newest supersedes: invalidate the prior OUTSTANDING link for this email
    // server-side, at issue time (SPEC §5.1).
    const prevJti = this.outstandingByEmail.get(email);
    if (prevJti) {
      const prev = this.byJti.get(prevJti);
      if (prev && prev.status === "outstanding") prev.status = "superseded";
    }
    this.byJti.set(record.jti, { ...record, email, status: "outstanding" });
    this.outstandingByEmail.set(email, record.jti);
  }

  async consume(jti: string): Promise<ConsumeResult> {
    const rec = this.byJti.get(jti);
    if (!rec) return { outcome: "not_found" };
    if (rec.status === "consumed") return { outcome: "already_consumed", record: rec };
    if (rec.status === "superseded") return { outcome: "superseded", record: rec };
    rec.status = "consumed"; // single-threaded JS → this read-modify-write is atomic
    return { outcome: "consumed", record: rec };
  }

  async get(jti: string): Promise<MagicLinkRecord | undefined> {
    return this.byJti.get(jti);
  }
}

export class InMemoryUserStore implements UserStore {
  readonly users = new Map<string, AuthUser>();

  async createOrLoadUser(email: string): Promise<AuthUser> {
    const norm = normalizeEmail(email);
    const existing = this.users.get(norm);
    if (existing) return existing;
    const user: AuthUser = { id: randomUUID(), email: norm, tenantId: randomUUID() };
    this.users.set(norm, user);
    return user;
  }
}
