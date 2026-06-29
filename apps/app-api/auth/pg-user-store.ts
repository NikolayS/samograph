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
import type { UserStore } from "./stores.ts";

export class PostgresUserStore implements UserStore {
  constructor(private readonly sql: SQL) {}

  async createOrLoadUser(_email: string): Promise<AuthUser> {
    throw new Error("not implemented: PostgresUserStore.createOrLoadUser");
  }
}
