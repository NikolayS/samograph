/**
 * DB-bootstrap integration test — reproduces PROD's non-superuser topology.
 *
 * Dev/CI connect to Postgres AS THE CONTAINER SUPERUSER (`POSTGRES_USER=samograph`
 * in `scripts/dev-local.sh` + `.github/workflows/ci.yml`), and `rls.test.ts` seeds
 * as that superuser. A superuser can `SET ROLE` with no grant and bypasses RLS, so
 * the CI suite NEVER exercises the real prod prerequisite: the app connects as a
 * NON-superuser LOGIN role that must be EXPLICITLY wired to
 *   1. `SET ROLE samograph_app` (needs `GRANT samograph_app TO <login>`), and
 *   2. run the pre-tenant auth `INSERT INTO tenants` under FORCE RLS
 *      (needs `ALTER ROLE <login> BYPASSRLS`).
 * That wiring lived ONLY in a manual VM step and broke prod sign-in twice (#186 /
 * #180). This test creates a fresh non-superuser login role and asserts the flow
 * FAILS without the wiring and WORKS after `bootstrap.sql` — so a regression fails
 * CI red on the SAME superuser runner that was previously blind to it.
 *
 * DB-gated exactly like `rls.test.ts`: skips cleanly when DATABASE_URL is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { connect, databaseUrl, setTenant } from "./client.ts";
import { migrate } from "./migrate.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

// A fixed, self-contained login role we create and tear down. Fixed (not random)
// so a crashed run leaves exactly one well-known role to drop, never orphans.
const APP_LOGIN_ROLE = "test_bootstrap_app_login";
const APP_LOGIN_PW = "bootstrap_db_test_pw";

/** The login-role DSN: the superuser DATABASE_URL with user/password swapped. */
function appLoginDsn(): string {
  const u = new URL(databaseUrl());
  u.username = APP_LOGIN_ROLE;
  u.password = APP_LOGIN_PW;
  return u.toString();
}

/** Run `fn`, returning the thrown error's SQLSTATE (`errno`), or undefined if it succeeds. */
async function captureErrno(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { errno?: string }).errno;
  }
}

/** Drop the test login role (and anything it owns) if a prior run left it behind. */
async function dropLoginRoleIfExists(sql: SQL): Promise<void> {
  const exists = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${APP_LOGIN_ROLE}`;
  if (exists.length === 0) return;
  await sql.unsafe(`DROP OWNED BY ${APP_LOGIN_ROLE}`);
  await sql.unsafe(`DROP ROLE ${APP_LOGIN_ROLE}`);
}

d("DB bootstrap wires a non-superuser login role (§5.10 / #186)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const userC = randomUUID(); // owner for the post-bootstrap pre-tenant INSERT
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const callA = randomUUID();
  const callB = randomUUID();
  let insertedTenantId: string | null = null;

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);

    // Two isolated tenants (each with one call) + a third owner with NO tenant,
    // used later for the pre-tenant `INSERT INTO tenants` the auth path performs.
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}),
      (${userB}, ${`${userB}@b.test`}),
      (${userC}, ${`${userC}@c.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}),
      (${tenantB}, ${userB})`;
    await sql`INSERT INTO calls (id, tenant_id, meeting_url, status) VALUES
      (${callA}, ${tenantA}, 'https://meet.google.com/a', 'IN_CALL'),
      (${callB}, ${tenantB}, 'https://meet.google.com/b', 'IN_CALL')`;

    // Fresh NON-superuser login role, NO membership + NO BYPASSRLS yet — exactly
    // prod's starting state before the manual (now repo-tracked) bootstrap runs.
    await dropLoginRoleIfExists(sql);
    await sql.unsafe(
      `CREATE ROLE ${APP_LOGIN_ROLE} LOGIN PASSWORD '${APP_LOGIN_PW}' ` +
        `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  });

  afterAll(async () => {
    if (insertedTenantId) await sql`DELETE FROM tenants WHERE id = ${insertedTenantId}`;
    await sql`DELETE FROM calls WHERE id IN (${callA}, ${callB})`;
    await sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB}, ${userC})`;
    await dropLoginRoleIfExists(sql);
    await sql.close();
  });

  it("WITHOUT bootstrap: the login role cannot SET ROLE (42501) nor INSERT INTO tenants", async () => {
    const app = new SQL(appLoginDsn());
    try {
      // (b) from the acceptance criteria: no `GRANT samograph_app TO <login>` yet,
      // so escalating to the runtime role is denied — the exact prod 42501.
      const setRoleErrno = await captureErrno(() => app.unsafe("SET ROLE samograph_app"));
      expect(setRoleErrno).toBe("42501");

      // And with no privilege on `tenants` (that grant only arrives via membership),
      // the pre-tenant auth INSERT is denied outright — also 42501.
      const insertErrno = await captureErrno(
        () => app`INSERT INTO tenants (owner_user_id) VALUES (${userC})`,
      );
      expect(insertErrno).toBe("42501");
    } finally {
      await app.close();
    }
  });

  describe("AFTER running bootstrap.sql for the login role", () => {
    let app: SQL;

    beforeAll(async () => {
      // Dynamic import so that, until bootstrap.ts exists, ONLY this block goes red
      // (the WITHOUT-bootstrap assertion above still runs and proves the gap).
      const { applyBootstrap } = await import("./bootstrap.ts");
      await applyBootstrap(sql, APP_LOGIN_ROLE);
      app = new SQL(appLoginDsn());
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    it("(a) SET LOCAL ROLE samograph_app succeeds and RLS still isolates cross-tenant", async () => {
      // Tenant A's context: only A's call is visible; B's is invisible.
      await app.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, tenantA);
        const mine = await tx`SELECT id FROM calls`;
        expect(mine.map((r: { id: string }) => r.id)).toEqual([callA]);
        const cross = await tx`SELECT count(*)::int AS c FROM calls WHERE tenant_id = ${tenantB}`;
        expect(cross[0].c).toBe(0);
      });

      // Switching app.tenant_id to B makes A's row invisible (and only B's shows).
      await app.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, tenantB);
        const rows = await tx`SELECT id FROM calls`;
        expect(rows.map((r: { id: string }) => r.id)).toEqual([callB]);
      });
    });

    it("(a) the login role runs the pre-tenant INSERT INTO tenants (BYPASSRLS through FORCE RLS)", async () => {
      // The magic-link auth path (PostgresUserStore) inserts a tenant BEFORE any
      // tenant context exists — no `SET ROLE`, no app.tenant_id. `tenants` has
      // FORCE RLS, so this only succeeds because the login role now has BYPASSRLS.
      const rows = (await app`
        INSERT INTO tenants (owner_user_id) VALUES (${userC}) RETURNING id`) as unknown as Array<{ id: string }>;
      insertedTenantId = rows[0].id;
      expect(insertedTenantId).toBeTruthy();
    });

    it("pins the invariant: samograph_app stays NOLOGIN + NOBYPASSRLS; login role has BYPASSRLS + membership", async () => {
      const runtime = await sql`
        SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'samograph_app'`;
      expect(runtime[0].rolcanlogin).toBe(false);
      expect(runtime[0].rolbypassrls).toBe(false);

      const login = await sql`
        SELECT rolbypassrls FROM pg_roles WHERE rolname = ${APP_LOGIN_ROLE}`;
      expect(login[0].rolbypassrls).toBe(true);

      const membership = await sql`
        SELECT 1
        FROM pg_auth_members m
        JOIN pg_roles grp ON grp.oid = m.roleid
        JOIN pg_roles mem ON mem.oid = m.member
        WHERE grp.rolname = 'samograph_app' AND mem.rolname = ${APP_LOGIN_ROLE}`;
      expect(membership.length).toBe(1);
    });
  });
});
