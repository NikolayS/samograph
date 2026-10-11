import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { FakeGoogleIdp } from "../../../packages/test-fakes/google-oauth/index.ts";
import { createAccountHandler } from "../account/http.ts";
import { InMemoryEmailSender } from "../auth/email.ts";
import { buildClearedSessionCookie, SESSION_COOKIE_NAME, signSession } from "../auth/session.ts";
import { InMemoryRateLimiter } from "../auth/rate-limit.ts";
import { buildClearedCalendarOAuthStateCookie, CALENDAR_OAUTH_COOKIE_NAME } from "./oauth-state.ts";
import { GoogleCalendarOAuth } from "./google-calendar-oauth.ts";
import { createCalendarHandler } from "./http.ts";
import { PostgresCalendarConnectionStore } from "./pg-store.ts";
import { CalendarService } from "./service.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;
const SESSION_SECRET = "calendar-erasure-db-session-secret-ffffffffffffffff";
const NOW = Date.now();

d("Calendar HTTP after account erasure (§5.14)", () => {
  let sql: ReturnType<typeof connect>;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
  });

  afterAll(async () => {
    for (const userId of createdUsers) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.close();
  });

  it("rejects every Calendar route for a tombstoned owner and never recreates a connection", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const email = `${userId}@calendar-erasure.test`;
    await sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantId}, ${userId})`;
    createdUsers.push(userId);

    const sessionValue = signSession({ userId, tenantId, iat: NOW }, SESSION_SECRET);
    const sessionCookie = `${SESSION_COOKIE_NAME}=${sessionValue}`;
    const idp = new FakeGoogleIdp();
    const provider = new GoogleCalendarOAuth({
      clientId: idp.clientId,
      clientSecret: "secret",
      redirectUri: "http://app-api.local/calendar/connect/callback",
      fetchImpl: idp.fetchImpl,
    });
    const key = Buffer.alloc(32, 7);
    const service = new CalendarService({
      provider,
      store: new PostgresCalendarConnectionStore(sql),
      rateLimiter: new InMemoryRateLimiter(),
      sessionSecret: SESSION_SECRET,
      clock: () => NOW,
      activeKey: key,
      activeKeyVersion: 1,
      decryptionKeys: new Map([[1, key]]),
    });
    const calendar = createCalendarHandler(service, SESSION_SECRET, () => NOW);

    // Seal a legitimate pre-erasure OAuth transaction so the stale callback
    // would exchange and persist a refresh token if the route only checked that
    // the retained tenants row still exists.
    const preEraseStart = await calendar(new Request("http://app-api.local/calendar/connect/start", {
      method: "POST",
      headers: { cookie: sessionCookie },
    }));
    expect(preEraseStart.status).toBe(200);
    const authorizationUrl = (await preEraseStart.json() as { authorization_url: string }).authorization_url;
    const grant = idp.authorize(authorizationUrl);
    const stateCookie = preEraseStart.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(stateCookie).toStartWith(`${CALENDAR_OAUTH_COOKIE_NAME}=`);

    const erased = await createAccountHandler({
      sql,
      sessionSecret: SESSION_SECRET,
      emailSender: new InMemoryEmailSender(),
      calendarOAuth: provider,
      calendarTokenDecryptionKeys: new Map([[1, key]]),
      now: () => NOW,
    })(new Request("http://app-api.local/account", { method: "DELETE", headers: { cookie: sessionCookie } }));
    expect(erased.status).toBe(200);

    async function expectDeadSession(response: Response): Promise<void> {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        code: "SAMO-AUTH-005",
        message: "You've been signed out. Please sign in again.",
        retryable: false,
      });
      expect(response.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE_NAME}=;`);
    }

    const start = await calendar(new Request("http://app-api.local/calendar/connect/start", {
      method: "POST",
      headers: { cookie: sessionCookie },
    }));
    await expectDeadSession(start);
    expect(start.headers.get("set-cookie") ?? "").not.toContain(CALENDAR_OAUTH_COOKIE_NAME);

    const callback = await calendar(new Request(
      `http://app-api.local/calendar/connect/callback?code=${grant.code}&state=${grant.state}`,
      { headers: { cookie: `${sessionCookie}; ${stateCookie}` } },
    ));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/auth");
    expect(callback.headers.getSetCookie()).toEqual([
      buildClearedSessionCookie(),
      buildClearedCalendarOAuthStateCookie(),
    ]);

    await expectDeadSession(await calendar(new Request("http://app-api.local/calendar/status", {
      headers: { cookie: sessionCookie },
    })));
    await expectDeadSession(await calendar(new Request("http://app-api.local/calendar/connection", {
      method: "DELETE",
      headers: { cookie: sessionCookie },
    })));

    const rows = (await sql`SELECT count(*)::int AS c FROM calendar_connections WHERE user_id = ${userId}`) as unknown as Array<{ c: number }>;
    expect(rows[0].c).toBe(0);
  });
});
