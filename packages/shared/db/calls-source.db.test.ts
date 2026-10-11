import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "./client.ts";
import { migrate } from "./migrate.ts";

const d = process.env.DATABASE_URL ? describe : describe.skip;

d("calls calendar source identity", () => {
  let sql: ReturnType<typeof connect>;
  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@test.invalid`}),
      (${userB}, ${`${userB}@test.invalid`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  it("rejects a duplicate calendar event in one tenant but permits it in another", async () => {
    const eventId = `event-${randomUUID()}`;
    await sql`INSERT INTO calls (tenant_id, meeting_url, source, source_event_id)
      VALUES (${tenantA}, 'https://meet.google.com/abc-defg-hij', 'calendar', ${eventId})`;

    try {
      await sql`INSERT INTO calls (tenant_id, meeting_url, source, source_event_id)
        VALUES (${tenantA}, 'https://meet.google.com/abc-defg-hij', 'calendar', ${eventId})`;
      throw new Error("expected duplicate insert to fail");
    } catch (error) {
      expect((error as { errno?: string }).errno).toBe("23505");
      const pgError = error as { constraint?: string; constraint_name?: string };
      expect(pgError.constraint ?? pgError.constraint_name)
        .toBe("calls_tenant_source_event_unique_idx");
    }

    expect(await sql`INSERT INTO calls (tenant_id, meeting_url, source, source_event_id)
      VALUES (${tenantB}, 'https://meet.google.com/abc-defg-hij', 'calendar', ${eventId})`).toBeDefined();
  });

  it("enforces the source and source-event pairing", async () => {
    await expect((async () => await sql`INSERT INTO calls (tenant_id, meeting_url, source, source_event_id)
      VALUES (${tenantA}, 'https://zoom.us/j/123', 'manual', ${`event-${randomUUID()}`})`)())
      .rejects.toMatchObject({ errno: "23514" });
    await expect((async () => await sql`INSERT INTO calls (tenant_id, meeting_url, source, source_event_id)
      VALUES (${tenantA}, 'https://zoom.us/j/456', 'calendar', NULL)`)())
      .rejects.toMatchObject({ errno: "23514" });

    expect(await sql`INSERT INTO calls (tenant_id, meeting_url, source, source_event_id)
      VALUES (${tenantA}, 'https://zoom.us/j/789', 'manual', NULL)`).toBeDefined();
  });
});
