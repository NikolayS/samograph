/**
 * Postgres-backed IdentityStore (SPEC §5.1, §5.10; issue #209) — the real
 * `(provider, subject)` → user resolution behind an external sign-in callback,
 * against `packages/shared/db` migration 0011.
 *
 * The callback resolves WHO is signing in BEFORE any tenant context exists, so
 * this path is privileged. `user_identities` is intentionally NOT granted to the
 * runtime `samograph_app` role and carries no RLS (0011) — a `SET LOCAL ROLE
 * samograph_app` transaction cannot even SELECT it (SQLSTATE 42501). The
 * injected `SQL` connection is therefore the privileged auth connection: a login
 * role with BYPASSRLS, the same one PostgresUserStore uses (the prod incident
 * behind #180 was a missing BYPASSRLS grant).
 *
 * `link` is a single upsert whose `DO UPDATE` list deliberately OMITS `user_id`.
 * Two concurrent callbacks for one subject therefore converge on ONE row still
 * owned by the ORIGINAL user, and an attempted re-link to a different user is a
 * no-op rather than an account takeover. Because the database — not the caller —
 * decides who owns the subject, the tenant is read back through `JOIN tenants ON
 * owner_user_id` in the same statement, so a returning signer needs no UserStore
 * hop and cannot be handed a tenant the row does not actually belong to.
 */
import type { SQL } from "bun";
import type {
  IdentityProvider,
  IdentityStore,
  LinkIdentityInput,
  LinkedIdentity,
} from "./identities.ts";

interface IdentityRow {
  provider: IdentityProvider;
  provider_subject: string;
  user_id: string;
  tenant_id: string;
  email: string | null;
}

function rowToIdentity(row: IdentityRow): LinkedIdentity {
  return {
    provider: row.provider,
    subject: row.provider_subject,
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
  };
}

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly sql: SQL) {}

  async findByProviderSubject(
    provider: IdentityProvider,
    subject: string,
  ): Promise<LinkedIdentity | undefined> {
    const rows = (await this.sql`
      SELECT i.provider, i.provider_subject, i.user_id, t.id AS tenant_id, i.email
      FROM user_identities i
      JOIN tenants t ON t.owner_user_id = i.user_id
      WHERE i.provider = ${provider} AND i.provider_subject = ${subject}`) as unknown as IdentityRow[];
    return rows.length ? rowToIdentity(rows[0]) : undefined;
  }

  async link(input: LinkIdentityInput): Promise<LinkedIdentity> {
    const rows = (await this.sql`
      WITH upserted AS (
        INSERT INTO user_identities (user_id, provider, provider_subject, email, last_login_at)
        VALUES (${input.userId}, ${input.provider}, ${input.subject}, ${input.email}, now())
        ON CONFLICT (provider, provider_subject) DO UPDATE
          SET email = EXCLUDED.email, last_login_at = now()
        RETURNING user_id, provider, provider_subject, email
      )
      SELECT u.provider, u.provider_subject, u.user_id, t.id AS tenant_id, u.email
      FROM upserted u
      JOIN tenants t ON t.owner_user_id = u.user_id`) as unknown as IdentityRow[];

    if (!rows.length) {
      // The upsert itself committed (the CTE runs regardless of the outer join);
      // only the tenant lookup came back empty, which means the owning user has
      // no tenant row — a broken invariant, never a normal outcome.
      throw new Error(
        `linked ${input.provider} identity has no tenant for its owning user`,
      );
    }
    return rowToIdentity(rows[0]);
  }
}
