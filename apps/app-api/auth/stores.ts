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
import type { AuthUser, MagicLinkRecord, SignupMethod } from "./types.ts";
import { DEFAULT_SIGNUP_METHOD } from "./types.ts";

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
  /**
   * Create (or load) the user for `email` and ensure their 1:1 tenant exists.
   *
   * `signupMethod` is recorded ONLY when the row is created (migration 0012,
   * S5-1 item 7): it answers "how was this account created", so a returning
   * user — or one arriving down the OTHER credential path — never rewrites it.
   * It defaults to `magic_link`, which is both the historical truth for every
   * pre-0012 row and the value the magic-link callback passes explicitly.
   */
  createOrLoadUser(email: string, signupMethod?: SignupMethod): Promise<AuthUser>;
  /**
   * Look up the user for `email` WITHOUT creating one; `undefined` on a miss.
   *
   * Exists for the Google callback's miss branch (issue #209 / S5-1 item 5):
   * attaching a Google `sub` to an ALREADY-EXISTING magic-link account is
   * silent, so it is paired with a mandatory one-time notification email — the
   * only mechanism by which a takeover on that branch would ever be noticed,
   * since no session revocation exists anywhere in this system. Distinguishing
   * "linked to an existing account" from "created a new account" is what decides
   * whether that email is sent, and {@link createOrLoadUser} cannot answer it:
   * by the time it returns, the row exists either way.
   *
   * Read-only BY CONTRACT. A callback that asked this question with
   * `createOrLoadUser` would answer it by creating the account.
   */
  findByEmail(email: string): Promise<AuthUser | undefined>;
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
  /**
   * normalized email → the method the account was CREATED with. Mirrors
   * `users.signup_method`, whose upsert omits the column on DO UPDATE — so this
   * fake, like the DDL, is first-write-wins and a service test cannot pass here
   * for a reason that would fail against real Postgres.
   */
  readonly signupMethods = new Map<string, SignupMethod>();

  async createOrLoadUser(
    email: string,
    signupMethod: SignupMethod = DEFAULT_SIGNUP_METHOD,
  ): Promise<AuthUser> {
    const norm = normalizeEmail(email);
    const existing = this.users.get(norm);
    if (existing) return existing;
    const user: AuthUser = { id: randomUUID(), email: norm, tenantId: randomUUID() };
    this.users.set(norm, user);
    this.signupMethods.set(norm, signupMethod);
    return user;
  }

  /** Read-only lookup — normalizes exactly as `createOrLoadUser` does, so the
   *  two can never disagree about whether an address is already taken. */
  async findByEmail(email: string): Promise<AuthUser | undefined> {
    return this.users.get(normalizeEmail(email));
  }
}
