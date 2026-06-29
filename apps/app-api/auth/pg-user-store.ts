/**
 * Postgres-backed UserStore (SPEC §5.1, §5.10) — the real user+tenant creation
 * behind the magic-link callback, against `packages/shared/db`.
 *
 * Auth runs BEFORE any tenant context exists, so this path is privileged: the
 * `users` and `tenants` tables are intentionally NOT granted to the runtime
 * `samograph_app` role and carry no RLS (see migration 0001/0002). The injected
 * `SQL` connection is therefore the privileged auth connection. Creating a user
 * also provisions their 1:1 tenant; a returning user loads the same rows
 * idempotently (no duplicate user, no duplicate tenant).
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
