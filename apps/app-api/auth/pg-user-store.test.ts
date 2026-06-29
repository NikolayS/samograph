/**
 * Postgres integration test for the real user+tenant creation behind the
 * magic-link callback (SPEC §5.1, §5.10, §6.2 #6 GREEN).
 *
 * Runs against the CI ephemeral Postgres (real migrations, no mocks; §6.1) and
 * SKIPS cleanly when DATABASE_URL is unset — exactly like the RLS suite. Auth is
 * a privileged pre-tenant path, so it connects as the migration/superuser role
 * (users/tenants are deliberately ungranted to samograph_app and carry no RLS).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect } from "../../../packages/shared/db/index.ts";
import { migrate } from "../../../packages/shared/db/index.ts";
import { PostgresUserStore } from "./pg-user-store.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("PostgresUserStore (§5.1 user+tenant creation)", () => {
  let sql: ReturnType<typeof connect>;
  const email = `magic-${Date.now()}@example.com`;

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    // tenants cascade-delete via owner_user_id FK ON DELETE CASCADE.
    await sql`DELETE FROM users WHERE email = ${email.toLowerCase()}`;
    await sql.close();
  });

  it("creates a user + 1:1 tenant on first login, loads idempotently after", async () => {
    const store = new PostgresUserStore(sql);

    const first = await store.createOrLoadUser(email.toUpperCase());
    expect(first.email).toBe(email.toLowerCase()); // normalized
    expect(first.id).toBeTruthy();
    expect(first.tenantId).toBeTruthy();

    // Exactly one user row and one tenant row, wired owner→tenant.
    const users = await sql`SELECT id, email FROM users WHERE email = ${email.toLowerCase()}`;
    expect(users.length).toBe(1);
    expect(users[0].id).toBe(first.id);

    const tenants = await sql`SELECT id, owner_user_id FROM tenants WHERE owner_user_id = ${first.id}`;
    expect(tenants.length).toBe(1);
    expect(tenants[0].id).toBe(first.tenantId);

    // Second login for the SAME email loads the same rows — no duplicates.
    const second = await store.createOrLoadUser(email.toLowerCase());
    expect(second).toEqual(first);
    const usersAfter = await sql`SELECT count(*)::int AS c FROM users WHERE email = ${email.toLowerCase()}`;
    expect(usersAfter[0].c).toBe(1);
    const tenantsAfter = await sql`SELECT count(*)::int AS c FROM tenants WHERE owner_user_id = ${first.id}`;
    expect(tenantsAfter[0].c).toBe(1);
  });
});
