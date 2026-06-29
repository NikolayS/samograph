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

export class InMemoryMagicLinkStore implements MagicLinkStore {
  private readonly byJti = new Map<string, MagicLinkRecord>();
  private readonly outstandingByEmail = new Map<string, string>();

  async issue(_record: MagicLinkRecord): Promise<void> {
    throw new Error("not implemented: InMemoryMagicLinkStore.issue");
  }

  async consume(_jti: string): Promise<ConsumeResult> {
    throw new Error("not implemented: InMemoryMagicLinkStore.consume");
  }

  async get(_jti: string): Promise<MagicLinkRecord | undefined> {
    throw new Error("not implemented: InMemoryMagicLinkStore.get");
  }
}

export class InMemoryUserStore implements UserStore {
  readonly users = new Map<string, AuthUser>();

  async createOrLoadUser(_email: string): Promise<AuthUser> {
    throw new Error("not implemented: InMemoryUserStore.createOrLoadUser");
  }
}
