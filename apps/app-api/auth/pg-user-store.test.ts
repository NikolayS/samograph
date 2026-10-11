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
import { readdirSync } from "node:fs";
import { MIGRATIONS_DIR, migrationVersions } from "../../../packages/shared/db/migrate.ts";

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

  /**
   * `findByEmail` is the READ-ONLY lookup the Google callback uses to tell
   * "attached a Google sub to an existing account" (which must fire the one-time
   * notification email, S5-1 item 5) from "created a new account" (which must
   * not). Its read-only-ness is asserted against the real database, not just
   * promised in a comment: asking with `createOrLoadUser` would answer the
   * question by creating the row.
   */
  it("findByEmail returns the existing user + tenant, normalized, and CREATES NOTHING", async () => {
    const store = new PostgresUserStore(sql);
    const created = await store.createOrLoadUser(email.toLowerCase());

    expect(await store.findByEmail(email.toUpperCase())).toEqual(created);
    expect(await store.findByEmail(`  ${email.toLowerCase()} `)).toEqual(created);

    const missing = `absent-${Date.now()}@example.com`;
    expect(await store.findByEmail(missing)).toBeUndefined();
    const rows = await sql`SELECT count(*)::int AS c FROM users WHERE email = ${missing}`;
    expect(rows[0].c).toBe(0);
  });
});

/**
 * `users.signup_method` — migration 0012, S5-1 item 7 / issue #222.
 *
 * The column records HOW THE ACCOUNT WAS CREATED, and nothing else. It is the
 * source of the `method` label on `samograph_funnel_stage`, which is what lets
 * §9 be re-baselined per credential path after Google ships. Two invariants
 * carry the weight: both credential paths WRITE it on creation, and NOTHING
 * rewrites it afterwards — `users.email` immutability (S5-1 item 3) has exactly
 * the same shape, and for the same reason: a later sign-in is not a re-signup.
 */
d("users.signup_method (migration 0012, §5.11 / §9 — #222)", () => {
  let sql: ReturnType<typeof connect>;
  const magicEmail = `sm-magic-${Date.now()}@example.com`;
  const googleEmail = `sm-google-${Date.now()}@example.com`;

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE email IN (${magicEmail}, ${googleEmail})`;
    await sql.close();
  });

  it("ships as migration 0012_users_signup_method.sql", () => {
    expect(migrationVersions()).toContain("0012_users_signup_method");
    expect(readdirSync(MIGRATIONS_DIR)).toContain("0012_users_signup_method.sql");
  });

  it("a magic-link signup writes exactly 'magic_link'", async () => {
    const store = new PostgresUserStore(sql);
    const user = await store.createOrLoadUser(magicEmail, "magic_link");
    const rows = await sql`SELECT signup_method FROM users WHERE id = ${user.id}`;
    expect(rows[0].signup_method).toBe("magic_link");
  });

  it("a Google signup for a NEW user writes exactly 'google'", async () => {
    const store = new PostgresUserStore(sql);
    const user = await store.createOrLoadUser(googleEmail, "google");
    const rows = await sql`SELECT signup_method FROM users WHERE id = ${user.id}`;
    expect(rows[0].signup_method).toBe("google");
  });

  it("linking a second credential NEVER rewrites signup_method", async () => {
    const store = new PostgresUserStore(sql);
    const created = await store.createOrLoadUser(magicEmail, "magic_link");
    // The upsert's DO UPDATE deliberately omits signup_method, so even the
    // racing path that reaches createOrLoadUser with the other method loses.
    const again = await store.createOrLoadUser(magicEmail, "google");
    expect(again.id).toBe(created.id);
    const rows = await sql`SELECT signup_method FROM users WHERE id = ${created.id}`;
    expect(rows[0].signup_method).toBe("magic_link");
  });

  it("pre-existing rows default to the documented 'magic_link'", async () => {
    // Rows written by code that predates 0012 (every prod row today, by
    // construction — there are no Google users yet).
    const legacy = `sm-legacy-${Date.now()}@example.com`;
    const rows = await sql`INSERT INTO users (email) VALUES (${legacy}) RETURNING signup_method`;
    expect(rows[0].signup_method).toBe("magic_link");
    await sql`DELETE FROM users WHERE email = ${legacy}`;
  });

  it("rejects a signup_method outside the closed domain", async () => {
    const bogus = `sm-bogus-${Date.now()}@example.com`;
    let code = "";
    try {
      await sql`INSERT INTO users (email, signup_method) VALUES (${bogus}, 'carrier_pigeon')`;
    } catch (err) {
      code = (err as { errno?: string; code?: string }).errno ?? (err as { code?: string }).code ?? "";
    }
    expect(code).toBe("23514"); // check_violation
  });
});
