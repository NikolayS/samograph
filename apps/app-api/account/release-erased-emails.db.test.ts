/**
 * Migration `0013_release_erased_account_emails` — the backfill half of #220.
 *
 * From this release on, `DELETE /account` releases the owner's address as part of
 * the erasure. Accounts erased BEFORE it shipped still carry a live address on
 * their retained `users` row, which is exactly the state that lets a later Google
 * sign-in walk `findByEmail` into the tombstone and re-create a `user_identities`
 * row for an erased person. The migration closes that state.
 *
 * The migration is a single idempotent `UPDATE` keyed on the SAME predicate
 * `tenantActive` uses — the `audit_log(action='account_deleted')` tombstone — so
 * this test runs the SHIPPED file verbatim (read off disk, executed as-is) rather
 * than a paraphrase of it. `migrate()` has already applied it in `beforeAll`, so
 * every execution here is a re-run: proving idempotence and proving the predicate
 * on rows seeded afterwards, in one go.
 *
 * The blast radius is the whole point of the negative assertion: this statement
 * rewrites `users.email`, and a predicate that over-matched by one row would lock
 * a LIVE user out of their own account forever. An active user's address is
 * asserted byte-identical after every run.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, migrate } from "../../../packages/shared/db/index.ts";
import { MIGRATIONS_DIR } from "../../../packages/shared/db/migrate.ts";
import { ACCOUNT_DELETED_ACTION, tenantActive } from "../auth/owner-session.ts";
import { erasedAccountEmail } from "./http.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

/** The shipped migration body, verbatim — never a paraphrase of it. */
const MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "0013_release_erased_account_emails.sql"),
  "utf8",
);

d("0013_release_erased_account_emails — backfill for pre-#220 tombstones", () => {
  let sql: ReturnType<typeof connect>;
  const createdUsers: string[] = [];

  /** A user + their 1:1 tenant, optionally already carrying a §5.14 tombstone. */
  async function seedOwner(opts: { erased: boolean }): Promise<{
    userId: string;
    tenantId: string;
    email: string;
  }> {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const email = `backfill-${userId}@example.com`;
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    createdUsers.push(userId);
    if (opts.erased) {
      await sql`
        INSERT INTO audit_log (tenant_id, actor, action)
        VALUES (${tenantId}, ${`user:${userId}`}, ${ACCOUNT_DELETED_ACTION})`;
    }
    return { userId, tenantId, email };
  }

  async function emailOf(userId: string): Promise<string> {
    const rows = (await sql`SELECT email FROM users WHERE id = ${userId}`) as unknown as Array<{
      email: string;
    }>;
    return rows[0].email;
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    for (const id of createdUsers) await sql`DELETE FROM users WHERE id = ${id}`;
    await sql.close();
  });

  it("anonymizes a legacy tombstoned owner and leaves an active owner byte-identical", async () => {
    const legacy = await seedOwner({ erased: true });
    const active = await seedOwner({ erased: false });

    await sql.unsafe(MIGRATION);

    expect(await emailOf(legacy.userId)).toBe(erasedAccountEmail(legacy.userId));
    expect(await emailOf(active.userId)).toBe(active.email);

    // The tombstone contract is untouched: the row survives, the tenant stays
    // erased, and the ACTIVE tenant stays active.
    expect(await tenantActive(sql, legacy.tenantId)).toBe(false);
    expect(await tenantActive(sql, active.tenantId)).toBe(true);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const legacy = await seedOwner({ erased: true });
    const active = await seedOwner({ erased: false });

    await sql.unsafe(MIGRATION);
    const afterFirst = await emailOf(legacy.userId);
    await sql.unsafe(MIGRATION);

    expect(await emailOf(legacy.userId)).toBe(afterFirst);
    expect(await emailOf(legacy.userId)).toBe(erasedAccountEmail(legacy.userId));
    expect(await emailOf(active.userId)).toBe(active.email);
  });

  it("frees the released address for a genuinely fresh signup", async () => {
    const legacy = await seedOwner({ erased: true });

    await sql.unsafe(MIGRATION);

    const rows = (await sql`
      SELECT count(*)::int AS c FROM users WHERE email = ${legacy.email}`) as unknown as Array<{
      c: number;
    }>;
    expect(rows[0].c).toBe(0);
  });
});
