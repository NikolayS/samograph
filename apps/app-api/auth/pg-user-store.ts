/**
 * Postgres-backed UserStore (SPEC §5.1, §5.10) — the real user+tenant creation
 * behind the magic-link callback, against `packages/shared/db`.
 *
 * Auth runs BEFORE any tenant context exists, so this path is privileged. The
 * `users` table is intentionally NOT granted to the runtime `samograph_app` role
 * and carries no RLS. `tenants`, HOWEVER, IS granted to `samograph_app` and DOES
 * have RLS (ENABLE + FORCE, policy `tenants_tenant_isolation` — migrations
 * 0001/0002), so the pre-tenant `INSERT INTO tenants` here can only succeed on a
 * connection that BYPASSES that RLS. The injected `SQL` connection is therefore
 * the privileged auth connection — a login role with BYPASSRLS (the prod incident
 * behind #180 was a missing BYPASSRLS grant, fixed separately in DB bootstrap).
 * Creating a user also provisions their 1:1 tenant; a returning user loads the
 * same rows idempotently (no duplicate user, no duplicate tenant).
 */
import type { SQL } from "bun";
import type { AuthUser, SignupMethod } from "./types.ts";
import { DEFAULT_SIGNUP_METHOD } from "./types.ts";
import { normalizeEmail, type UserStore } from "./stores.ts";

export class PostgresUserStore implements UserStore {
  constructor(private readonly sql: SQL) {}

  /**
   * `signupMethod` is written ONLY on INSERT. The `DO UPDATE` list below
   * deliberately omits it (migration 0012, S5-1 item 7), so a user who signs in
   * down the other credential path — or two callbacks racing on one address —
   * keeps the method the account was CREATED with. The column feeds the `method`
   * label on the §5.11 funnel, and a metric that silently reclassified
   * historical cohorts would make every week-over-week comparison a lie.
   */
  async createOrLoadUser(
    email: string,
    signupMethod: SignupMethod = DEFAULT_SIGNUP_METHOD,
  ): Promise<AuthUser> {
    const norm = normalizeEmail(email);
    let userId!: string;
    let tenantId!: string;

    await this.sql.begin(async (tx) => {
      // Idempotent upsert: the no-op DO UPDATE makes RETURNING fire whether the
      // row was just inserted or already existed.
      const users = await tx`
        INSERT INTO users (email, signup_method) VALUES (${norm}, ${signupMethod})
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id`;
      userId = users[0].id as string;

      // 1:1 tenant per user (owner_user_id is UNIQUE).
      await tx`
        INSERT INTO tenants (owner_user_id) VALUES (${userId})
        ON CONFLICT (owner_user_id) DO NOTHING`;
      const tenants = await tx`SELECT id FROM tenants WHERE owner_user_id = ${userId}`;
      tenantId = tenants[0].id as string;
    });

    return { id: userId, email: norm, tenantId };
  }

  /**
   * Read-only lookup for the Google callback's miss branch (issue #209): does
   * this address ALREADY have an account? No INSERT, no upsert, no side effect —
   * the answer decides whether the silent link fires its one-time notification
   * email, and asking with `createOrLoadUser` would create the very row it is
   * asking about.
   *
   * The JOIN mirrors `createOrLoadUser`'s 1:1 invariant: a user with no tenant
   * row is treated as a miss rather than returned with a fabricated tenant id.
   */
  async findByEmail(email: string): Promise<AuthUser | undefined> {
    const norm = normalizeEmail(email);
    const rows = (await this.sql`
      SELECT u.id, u.email, t.id AS tenant_id
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
      WHERE u.email = ${norm}`) as unknown as Array<{
      id: string;
      email: string;
      tenant_id: string;
    }>;
    if (rows.length === 0) return undefined;
    return { id: rows[0].id, email: rows[0].email, tenantId: rows[0].tenant_id };
  }
}
