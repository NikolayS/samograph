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
import type { AuthUser } from "./types.ts";
import { normalizeEmail, type UserStore } from "./stores.ts";

export class PostgresUserStore implements UserStore {
  constructor(private readonly sql: SQL) {}

  async createOrLoadUser(email: string): Promise<AuthUser> {
    const norm = normalizeEmail(email);
    let userId!: string;
    let tenantId!: string;

    await this.sql.begin(async (tx) => {
      // Idempotent upsert: the no-op DO UPDATE makes RETURNING fire whether the
      // row was just inserted or already existed.
      const users = await tx`
        INSERT INTO users (email) VALUES (${norm})
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
}
