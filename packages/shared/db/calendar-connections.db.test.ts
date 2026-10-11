/** Real-migration tests for the privileged Calendar credential table. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, migrate, setTenant } from "./index.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("calendar_connections migration", () => {
  let sql: ReturnType<typeof connect>;
  const users: string[] = [];

  async function freshUser(tenantId?: string): Promise<{ userId: string; tenantId: string }> {
    const userId = randomUUID();
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@example.test`})`;
    let resolvedTenantId = tenantId;
    if (resolvedTenantId === undefined) {
      const rows = (await sql`
        INSERT INTO tenants (owner_user_id) VALUES (${userId}) RETURNING id`) as unknown as Array<{
        id: string;
      }>;
      resolvedTenantId = rows[0].id;
    }
    users.push(userId);
    return { userId, tenantId: resolvedTenantId };
  }

  async function insertConnection(userId: string, tenantId: string): Promise<string> {
    const rows = (await sql`
      INSERT INTO calendar_connections (
        user_id, tenant_id, encrypted_refresh_token, refresh_token_iv,
        refresh_token_tag, encryption_key_version, granted_scopes
      ) VALUES (
        ${userId}, ${tenantId}, ${Buffer.from("ciphertext")}, ${Buffer.alloc(12)},
        ${Buffer.alloc(16)}, 1,
        ARRAY['https://www.googleapis.com/auth/calendar.events.readonly']
      ) RETURNING id`) as unknown as Array<{ id: string }>;
    return rows[0].id;
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`;
    await sql.close();
  });

  it("has the exact privileged-table RLS and runtime privilege posture", async () => {
    const table = (await sql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid = 'calendar_connections'::regclass`) as unknown as Array<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(table).toEqual([{ relrowsecurity: false, relforcerowsecurity: false }]);

    const privileges = (await sql`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'calendar_connections'
        AND grantee = 'samograph_app'
      ORDER BY privilege_type`) as unknown as Array<{ privilege_type: string }>;
    expect(privileges).toEqual([]);

    let errno: string | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, randomUUID());
        await tx`SELECT id FROM calendar_connections`;
      });
    } catch (error) {
      errno = (error as { errno?: string }).errno;
    }
    expect(errno).toBe("42501");
  });

  it("allows independent Google rows for multiple tenant owners", async () => {
    const owner = await freshUser();
    const otherOwner = await freshUser();
    const ids = [
      await insertConnection(owner.userId, owner.tenantId),
      await insertConnection(otherOwner.userId, otherOwner.tenantId),
    ];
    const rows = (await sql`
      SELECT id, user_id, tenant_id, provider, status, broken_reason,
             octet_length(refresh_token_iv)::int AS iv_length,
             octet_length(refresh_token_tag)::int AS tag_length,
             encryption_key_version
      FROM calendar_connections WHERE id = ${ids[0]} OR id = ${ids[1]} ORDER BY user_id`) as unknown as Array<{
      id: string; user_id: string; tenant_id: string; provider: string; status: string;
      broken_reason: string | null; iv_length: number; tag_length: number;
      encryption_key_version: number;
    }>;
    expect(rows).toEqual([
      { id: ids[0], user_id: owner.userId, tenant_id: owner.tenantId, provider: "google", status: "connected", broken_reason: null, iv_length: 12, tag_length: 16, encryption_key_version: 1 },
      { id: ids[1], user_id: otherOwner.userId, tenant_id: otherOwner.tenantId, provider: "google", status: "connected", broken_reason: null, iv_length: 12, tag_length: 16, encryption_key_version: 1 },
    ].sort((a, b) => a.user_id.localeCompare(b.user_id)));
  });

  it("rejects a connection pairing a user with another user's tenant", async () => {
    const userA = await freshUser();
    const userB = await freshUser();
    let errno: string | undefined;
    try {
      await insertConnection(userA.userId, userB.tenantId);
    } catch (error) {
      errno = (error as { errno?: string }).errno;
    }
    expect(errno).toBe("23503");
  });

  it("allows only one Google connection per user", async () => {
    const user = await freshUser();
    await insertConnection(user.userId, user.tenantId);
    let errno: string | undefined;
    try {
      await insertConnection(user.userId, user.tenantId);
    } catch (error) {
      errno = (error as { errno?: string }).errno;
    }
    expect(errno).toBe("23505");
  });

  it("rejects exact invalid provider, IV, tag, key-version, and status states", async () => {
    const user = await freshUser();
    const base = async (provider: string, iv: Buffer, tag: Buffer, version: number, status: string, reason: string | null) => {
      try {
        await sql`INSERT INTO calendar_connections (
          user_id, tenant_id, provider, encrypted_refresh_token, refresh_token_iv,
          refresh_token_tag, encryption_key_version, granted_scopes, status, broken_reason
        ) VALUES (${user.userId}, ${user.tenantId}, ${provider}, ${Buffer.from("cipher")},
          ${iv}, ${tag}, ${version}, ARRAY[]::text[], ${status}, ${reason})`;
        return undefined;
      } catch (error) {
        return (error as { errno?: string }).errno;
      }
    };
    expect(await base("outlook", Buffer.alloc(12), Buffer.alloc(16), 1, "connected", null)).toBe("23514");
    expect(await base("google", Buffer.alloc(11), Buffer.alloc(16), 1, "connected", null)).toBe("23514");
    expect(await base("google", Buffer.alloc(12), Buffer.alloc(15), 1, "connected", null)).toBe("23514");
    expect(await base("google", Buffer.alloc(12), Buffer.alloc(16), 0, "connected", null)).toBe("23514");
    expect(await base("google", Buffer.alloc(12), Buffer.alloc(16), 1, "connected", "revoked")).toBe("23514");
  });

  for (const [label, reason] of [
    ["NULL", null],
    ["arbitrary text", "arbitrary"],
  ] as const) {
    it(`rejects status broken with ${label} broken_reason`, async () => {
      const user = await freshUser();
      let errno: string | undefined;
      try {
        await sql`INSERT INTO calendar_connections (
          user_id, tenant_id, encrypted_refresh_token, refresh_token_iv,
          refresh_token_tag, encryption_key_version, granted_scopes, status, broken_reason
        ) VALUES (${user.userId}, ${user.tenantId}, ${Buffer.from("cipher")},
          ${Buffer.alloc(12)}, ${Buffer.alloc(16)}, 1, ARRAY[]::text[], 'broken', ${reason})`;
      } catch (error) {
        errno = (error as { errno?: string }).errno;
      }
      expect(errno).toBe("23514");
    });
  }
});
