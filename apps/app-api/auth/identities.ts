/**
 * Server-side state for EXTERNAL sign-in identities: the provider-identity store
 * and its in-memory fake (SPEC §5.1; issue #209).
 *
 * Identity is keyed on `(provider, subject)` — the provider's opaque, immutable
 * `sub` — and NEVER on the mutable, provider-controlled email. A known subject
 * therefore resolves to its user without consulting email at all, which is what
 * stops a provider-side rename from locking a user out of her own tenant and
 * stops a reassigned corporate address from walking its new holder into the
 * previous holder's tenant (migration 0011 carries the full rationale).
 *
 * Like `stores.ts`, this is an interface plus an in-memory fake so the security
 * suite runs with no network and no database. The fake ENFORCES what the DDL
 * enforces — one row per `(provider, subject)`, `user_id` never moved by a
 * re-link, and no identity for a user that does not exist — so a service test
 * that passes here cannot pass for the wrong reason against real Postgres. The
 * Postgres adapter (pg-identity-store.ts) implements the same contract over the
 * privileged pre-tenant connection.
 */
import type { AuthUser } from "./types.ts";

/** The external sign-in providers we accept. Mirrors the 0011 CHECK domain. */
export type IdentityProvider = "google";

/** A provider identity resolved to the local user (and their 1:1 tenant). */
export interface LinkedIdentity {
  provider: IdentityProvider;
  /** The provider's opaque, immutable subject id (Google's `sub`). */
  subject: string;
  userId: string;
  tenantId: string;
  /** The address the provider asserted — audit/display only, never the key. */
  email: string | null;
}

/** What the callback knows when it links a subject to a user. */
export interface LinkIdentityInput {
  provider: IdentityProvider;
  subject: string;
  userId: string;
  email: string | null;
}

export interface IdentityStore {
  /**
   * Resolve a provider identity. `undefined` (never `null`) on a miss, matching
   * `MagicLinkStore.get`.
   */
  findByProviderSubject(
    provider: IdentityProvider,
    subject: string,
  ): Promise<LinkedIdentity | undefined>;

  /**
   * Upsert the identity and return the AUTHORITATIVE linked identity.
   *
   * On a conflicting `(provider, subject)` this refreshes the asserted email but
   * NEVER moves the row to `input.userId` — so the returned `userId`/`tenantId`
   * may differ from what the caller passed. That is the point: it is what makes
   * two concurrent callbacks converge on one identity, and what makes an
   * attempted re-link a no-op rather than a takeover.
   */
  link(input: LinkIdentityInput): Promise<LinkedIdentity>;
}

/**
 * The 1:1 user→tenant fact the Postgres store reads with `JOIN tenants ON
 * owner_user_id`. `InMemoryUserStore` satisfies this structurally, so the fake
 * derives the tenant from exactly the same source the real store does instead of
 * trusting a caller-supplied value the database would override.
 */
export interface UserDirectory {
  readonly users: ReadonlyMap<string, AuthUser>;
}

export class InMemoryIdentityStore implements IdentityStore {
  /** Every linked identity, in link order (inspection helper for tests). */
  readonly records: LinkedIdentity[] = [];

  constructor(private readonly directory: UserDirectory) {}

  async findByProviderSubject(
    provider: IdentityProvider,
    subject: string,
  ): Promise<LinkedIdentity | undefined> {
    const found = this.find(provider, subject);
    return found ? { ...found } : undefined;
  }

  async link(input: LinkIdentityInput): Promise<LinkedIdentity> {
    const existing = this.find(input.provider, input.subject);
    if (existing) {
      // `ON CONFLICT (provider, provider_subject) DO UPDATE SET email, …` —
      // `userId` is deliberately absent, so the ORIGINAL owner survives.
      existing.email = input.email;
      return { ...existing };
    }

    // Stands in for the `user_id` FK: no identity may reference a missing user.
    const tenantId = this.tenantIdFor(input.userId);
    if (!tenantId) {
      throw new Error(`no user ${input.userId} to link a ${input.provider} identity to`);
    }

    const record: LinkedIdentity = {
      provider: input.provider,
      subject: input.subject,
      userId: input.userId,
      tenantId,
      email: input.email,
    };
    this.records.push(record);
    return { ...record };
  }

  private find(provider: IdentityProvider, subject: string): LinkedIdentity | undefined {
    return this.records.find((r) => r.provider === provider && r.subject === subject);
  }

  private tenantIdFor(userId: string): string | undefined {
    for (const user of this.directory.users.values()) {
      if (user.id === userId) return user.tenantId;
    }
    return undefined;
  }
}
