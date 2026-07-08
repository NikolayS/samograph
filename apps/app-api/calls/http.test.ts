/**
 * `/calls` HTTP adapter — DB-free red/green cases (SPEC §5.2, §5.16).
 *
 * These exercise the paths that MUST short-circuit before any database access:
 *   • no / invalid session cookie  → 401, bodyless (authentication failure)
 *   • valid session + bad URL      → 400 `SAMO-CALL-URL`, NO call created
 *   • unknown route                → 404
 * To prove "no DB and no enqueue happen on a rejected request", the injected
 * `sql` throws on ANY access and the orchestrator seam is a spy; both must stay
 * untouched on every rejection here.
 */
import { describe, it, expect } from "bun:test";
import type { SQL } from "bun";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import type { OrchestratorJob } from "../../bot-orchestrator/index.ts";
import { createCallsHandler } from "./http.ts";

const SESSION_SECRET = "calls-test-session-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";

/** A `sql` that detonates on ANY use — proves a path never reaches the DB. */
const throwingSql = new Proxy(
  function () {
    throw new Error("DB must not be touched on this request path");
  },
  {
    get() {
      throw new Error("DB must not be touched on this request path");
    },
    apply() {
      throw new Error("DB must not be touched on this request path");
    },
  },
) as unknown as SQL;

function makeHandler() {
  const jobs: OrchestratorJob[] = [];
  const handler = createCallsHandler({
    sql: throwingSql,
    sessionSecret: SESSION_SECRET,
    enqueue: (job) => {
      jobs.push(job);
    },
  });
  return { handler, jobs };
}

function cookieHeader(value: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${value}` };
}

function validSessionCookie(): string {
  // FRESH iat: the handler verifies against the wall clock and now enforces the
  // 30-day server-side session TTL (#57), so a 1970 iat would 401 here.
  return signSession({ userId: USER_ID, tenantId: TENANT_ID, iat: Date.now() }, SESSION_SECRET);
}

function postCalls(headers: Record<string, string>, body: unknown) {
  return new Request("http://app-api.local/calls", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /calls — authentication (§5.1)", () => {
  it("returns a bodyless 401 with no session cookie, never touching DB or the orchestrator", async () => {
    const { handler, jobs } = makeHandler();
    const res = await handler(postCalls({}, { meeting_url: "https://meet.google.com/abc-defg-hij" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(jobs).toEqual([]);
  });

  it("returns a bodyless 401 when the session cookie fails verification (wrong secret)", async () => {
    const { handler, jobs } = makeHandler();
    const tampered = signSession({ userId: USER_ID, tenantId: TENANT_ID, iat: 1 }, "a-different-secret");
    const res = await handler(
      postCalls(cookieHeader(tampered), { meeting_url: "https://meet.google.com/abc-defg-hij" }),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(jobs).toEqual([]);
  });
});

describe("POST /calls — URL validation (§5.2, §5.16)", () => {
  it("rejects a non-meeting URL with a typed 400 SAMO-CALL-URL and creates no call", async () => {
    const { handler, jobs } = makeHandler();
    const res = await handler(
      postCalls(cookieHeader(validSessionCookie()), { meeting_url: "https://example.com/not-a-meeting" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: "SAMO-CALL-URL",
      message: "That doesn't look like a Zoom or Google Meet meeting link.",
      retryable: false,
    });
    expect(jobs).toEqual([]); // no orchestrator enqueue — and the throwingSql proves no row
  });

  it("rejects a missing meeting_url field with the same typed 400", async () => {
    const { handler, jobs } = makeHandler();
    const res = await handler(postCalls(cookieHeader(validSessionCookie()), {}));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("SAMO-CALL-URL");
    expect(jobs).toEqual([]);
  });
});

describe("/calls — routing", () => {
  it("returns 404 for an unknown route", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://app-api.local/nope"));
    expect(res.status).toBe(404);
  });
});
