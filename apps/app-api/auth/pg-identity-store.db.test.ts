/**
 * Postgres integration test for the provider-identity store (SPEC §5.1, §5.10;
 * issue #209 acceptance criteria 7 and 10).
 *
 * Runs against the CI ephemeral Postgres (real migration 0011, no mocks; §6.1)
 * and SKIPS cleanly when DATABASE_URL is unset — exactly like the
 * PostgresUserStore / PostgresMagicLinkStore suites. The OAuth callback is a
 * privileged pre-tenant path, so this connects as the migration/superuser role
 * (`user_identities` is deliberately ungranted to `samograph_app` and carries no
 * RLS, mirroring `users`/`magic_links`), and that ungrantedness is itself
 * asserted below (SQLSTATE 42501 under `SET LOCAL ROLE samograph_app`).
 *
 * The security-critical property proven here is the one the DDL exists for: the
 * `ON CONFLICT (provider, provider_subject) DO UPDATE` upsert refreshes `email`
 * and `last_login_at` but NEVER moves `user_id`, so a re-link attempt against a
 * different user — including two genuinely concurrent callbacks — converges on
 * ONE row still owned by the ORIGINAL user.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, migrate, setTenant } from "../../../packages/shared/db/index.ts";
import { PostgresIdentityStore } from "./pg-identity-store.ts";
import type { AuthUser } from "./types.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("PostgresIdentityStore (§5.1 provider identity, privileged pre-tenant table)", () => {
  let sql: ReturnType<typeof connect>;
  const createdUsers: string[] = [];
  let subjectSeq = 0;

  /** A unique `sub` per assertion, so tests never collide on the UNIQUE key. */
  const subject = (label: string): string => `sub-${label}-${Date.now()}-${subjectSeq++}`;

  /** Insert a fresh user + their 1:1 tenant (the privileged pre-tenant seam). */
  async function freshUser(): Promise<AuthUser> {
    const id = randomUUID();
    const email = `ident-${id}@example.com`;
    await sql`INSERT INTO users (id, email) VALUES (${id}, ${email})`;
    const tenants = (await sql`
      INSERT INTO tenants (owner_user_id) VALUES (${id}) RETURNING id`) as unknown as Array<{
      id: string;
    }>;
    createdUsers.push(id);
    return { id, email, tenantId: tenants[0].id };
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    // user_identities and tenants both cascade from users.
    for (const id of createdUsers) await sql`DELETE FROM users WHERE id = ${id}`;
    await sql.close();
  });

  it("links a subject and reads back EXACTLY the identity, tenant joined", async () => {
    const user = await freshUser();
    const store = new PostgresIdentityStore(sql);
    const sub = subject("read");

    const linked = await store.link({
      provider: "google",
      subject: sub,
      userId: user.id,
      email: "a@x.test",
    });
    expect(linked).toEqual({
      provider: "google",
      subject: sub,
      userId: user.id,
      tenantId: user.tenantId,
      email: "a@x.test",
    });

    expect(await store.findByProviderSubject("google", sub)).toEqual({
      provider: "google",
      subject: sub,
      userId: user.id,
      tenantId: user.tenantId,
      email: "a@x.test",
    });
  });

  it("returns undefined for an unknown (provider, subject)", async () => {
    const store = new PostgresIdentityStore(sql);
    expect(await store.findByProviderSubject("google", subject("missing"))).toBeUndefined();
  });

  it("re-link keeps ONE row, refreshes email, and advances last_login_at", async () => {
    const user = await freshUser();
    const store = new PostgresIdentityStore(sql);
    const sub = subject("relink");

    // Timestamps are read as epoch MICROseconds computed in SQL: bun:sql hands
    // timestamptz back as a JS Date, and `Date.parse(aDate)` stringifies it to
    // WHOLE SECONDS — which would make the strict ordering assertion below pass
    // or fail on rounding rather than on behaviour.
    const stamps = async (): Promise<{ createdUs: number; loginUs: number }> => {
      const rows = (await sql`
        SELECT (extract(epoch FROM created_at) * 1000000)::bigint AS created_us,
               (extract(epoch FROM last_login_at) * 1000000)::bigint AS login_us
        FROM user_identities
        WHERE provider = 'google' AND provider_subject = ${sub}`) as unknown as Array<{
        created_us: string | number | bigint;
        login_us: string | number | bigint;
      }>;
      return { createdUs: Number(rows[0].created_us), loginUs: Number(rows[0].login_us) };
    };

    await store.link({ provider: "google", subject: sub, userId: user.id, email: "a@x.test" });
    const before = await stamps();

    // `now()` is transaction-START time, so the two upserts need distinct
    // transactions AND a real gap for the ordering assertion to be deterministic.
    await Bun.sleep(5);
    await store.link({ provider: "google", subject: sub, userId: user.id, email: "b@x.test" });

    const rows = (await sql`
      SELECT user_id, email FROM user_identities
      WHERE provider = 'google' AND provider_subject = ${sub}`) as unknown as Array<{
      user_id: string;
      email: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(user.id);
    expect(rows[0].email).toBe("b@x.test");

    const after = await stamps();
    expect(after.loginUs).toBeGreaterThan(before.loginUs);
    // created_at is the FIRST link and must not be rewritten by the upsert.
    expect(after.createdUs).toBe(before.createdUs);
  });

  it("NEVER moves an existing subject to a different user_id", async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const store = new PostgresIdentityStore(sql);
    const sub = subject("steal");

    await store.link({ provider: "google", subject: sub, userId: alice.id, email: "a@x.test" });
    const relinked = await store.link({
      provider: "google",
      subject: sub,
      userId: bob.id,
      email: "b@x.test",
    });

    // The ORIGINAL owner survives — user_id is deliberately absent from DO UPDATE.
    expect(relinked.userId).toBe(alice.id);
    expect(relinked.tenantId).toBe(alice.tenantId);
    expect(relinked.email).toBe("b@x.test");

    const rows = (await sql`
      SELECT user_id FROM user_identities
      WHERE provider = 'google' AND provider_subject = ${sub}`) as unknown as Array<{
      user_id: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(alice.id);
    expect(rows[0].user_id).not.toBe(bob.id);
  });

  it("lets ONE user hold TWO google identities (no UNIQUE (user_id, provider))", async () => {
    const user = await freshUser();
    const store = new PostgresIdentityStore(sql);
    const personal = subject("personal");
    const work = subject("work");

    await store.link({ provider: "google", subject: personal, userId: user.id, email: "p@x.test" });
    await store.link({ provider: "google", subject: work, userId: user.id, email: "w@x.test" });

    const rows = (await sql`
      SELECT provider_subject, email FROM user_identities
      WHERE user_id = ${user.id} ORDER BY provider_subject`) as unknown as Array<{
      provider_subject: string;
      email: string;
    }>;
    expect(rows.map((r) => r.provider_subject).sort()).toEqual([personal, work].sort());
    expect(rows.length).toBe(2);
  });

  it("CONCURRENT duplicate links converge on exactly ONE row (criterion 10)", async () => {
    const user = await freshUser();
    const sqlB = connect();
    try {
      const a = new PostgresIdentityStore(sql);
      const b = new PostgresIdentityStore(sqlB);
      const sub = subject("race");

      const [r1, r2] = await Promise.all([
        a.link({ provider: "google", subject: sub, userId: user.id, email: "a@x.test" }),
        b.link({ provider: "google", subject: sub, userId: user.id, email: "a@x.test" }),
      ]);
      expect(r1.userId).toBe(user.id);
      expect(r2.userId).toBe(user.id);

      const rows = (await sql`
        SELECT count(*)::int AS c FROM user_identities
        WHERE provider = 'google' AND provider_subject = ${sub}`) as unknown as Array<{ c: number }>;
      expect(rows[0].c).toBe(1);
    } finally {
      await sqlB.close();
    }
  });

  it("is PRIVILEGED: samograph_app cannot even SELECT it (SQLSTATE 42501)", async () => {
    let caught: { errno?: string; message?: string } | null = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, randomUUID());
        await tx`SELECT id FROM user_identities`;
      });
    } catch (err) {
      caught = err as { errno?: string; message?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.errno).toBe("42501");
    expect(caught?.message).toMatch(/permission denied/i);
  });

  it("cascades from users: deleting the user removes the identity", async () => {
    const user = await freshUser();
    const store = new PostgresIdentityStore(sql);
    const sub = subject("cascade");
    await store.link({ provider: "google", subject: sub, userId: user.id, email: "a@x.test" });

    await sql`DELETE FROM users WHERE id = ${user.id}`;

    const rows = (await sql`
      SELECT count(*)::int AS c FROM user_identities WHERE user_id = ${user.id}`) as unknown as Array<{
      c: number;
    }>;
    expect(rows[0].c).toBe(0);
  });

  it("rejects a provider outside the CHECK domain (23514)", async () => {
    const user = await freshUser();
    let caught: { errno?: string } | null = null;
    try {
      await sql`
        INSERT INTO user_identities (user_id, provider, provider_subject)
        VALUES (${user.id}, 'github', ${subject("badprovider")})`;
    } catch (err) {
      caught = err as { errno?: string };
    }
    expect(caught).not.toBeNull();
    // 23514 = check_violation.
    expect(caught?.errno).toBe("23514");
  });
});
