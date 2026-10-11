import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { PostgresCalendarConnectionStore } from "./pg-store.ts";
import type { CalendarConnection } from "./service.ts";

const d = process.env.DATABASE_URL ? describe : describe.skip;

d("PostgresCalendarConnectionStore", () => {
  let sql: ReturnType<typeof connect>;
  const users: string[] = [];

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    for (const userId of users) await sql`DELETE FROM users WHERE id=${userId}`;
    await sql.close();
  });

  it("round-trips single- and multi-element granted scopes through save", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    users.push(userId);
    await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@test`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenantId},${userId})`;

    const store = new PostgresCalendarConnectionStore(sql);
    const row: CalendarConnection = {
      id: randomUUID(),
      userId,
      tenantId,
      encryptedRefreshToken: Buffer.alloc(32, 1),
      refreshTokenIv: Buffer.alloc(12, 2),
      refreshTokenTag: Buffer.alloc(16, 3),
      encryptionKeyVersion: 1,
      grantedScopes: ["scope:calendar.read"],
      status: "connected",
      autoJoin: false,
      connectedAt: new Date("2026-08-26T12:00:00.000Z"),
      lastSyncAt: null,
      lastSyncErrorAt: null,
    };

    await store.save(row);
    expect((await store.get(userId, tenantId))?.grantedScopes).toEqual(["scope:calendar.read"]);

    row.grantedScopes = ["scope:calendar.read", "scope:calendar.events"];
    await store.save(row);
    expect((await store.get(userId, tenantId))?.grantedScopes).toEqual([
      "scope:calendar.read",
      "scope:calendar.events",
    ]);

    row.grantedScopes = ["scope,comma", 'scope"quote', "scope\\backslash"];
    await store.save(row);
    expect((await store.get(userId, tenantId))?.grantedScopes).toEqual([
      "scope,comma",
      'scope"quote',
      "scope\\backslash",
    ]);

    row.grantedScopes = [];
    await store.save(row);
    expect((await store.get(userId, tenantId))?.grantedScopes).toEqual([]);
  });
});
