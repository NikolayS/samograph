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
import {
  createCallsHandler,
  shareView,
  SHARE_VIEW_FIELDS,
  BOT_CREATE_PER_TENANT_LIMIT,
  BOT_CREATE_WINDOW_MS,
  RECALL_COST_CODE,
} from "./http.ts";
import { InMemoryRateLimiter } from "../auth/rate-limit.ts";

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

// ── §8 / §5.7: share-view ALLOWLIST — a new call field is hidden by default ──
describe("shareView — explicit allowlist (§5.7 reduced view, §8)", () => {
  /** The full owner view as `serializeCall` produces it, PLUS a hypothetical new field. */
  function ownerFullWithNewField() {
    return {
      id: "call-1",
      meeting_url: "https://meet.google.com/abc-defg-hij",
      status: "IN_CALL",
      status_reason: null,
      ingest_degraded: false,
      region: "eu-central",
      recall_bot_id: "bot-xyz",
      created_at: "2026-01-01T00:00:00.000Z",
      ended_at: null,
      first_line_at: "2026-01-01T00:00:05.000Z",
      // A newly-added / sensitive column someone adds to serializeCall later.
      secret_new_field: "should-never-reach-a-share-viewer",
    };
  }

  it("hides a NEWLY-ADDED field from share scope BY DEFAULT (allowlist, not denylist)", () => {
    const full = ownerFullWithNewField();
    const shared = shareView(full);
    // The new field IS present in the owner view but MUST NOT be in the share view.
    expect(full.secret_new_field).toBe("should-never-reach-a-share-viewer");
    expect("secret_new_field" in shared).toBe(false);
  });

  it("never exposes meeting_url, recall_bot_id, or region to share scope", () => {
    const shared = shareView(ownerFullWithNewField());
    expect("meeting_url" in shared).toBe(false);
    expect("recall_bot_id" in shared).toBe(false);
    expect("region" in shared).toBe(false);
  });

  it("exposes EXACTLY the allowlisted status-header + timeline fields, with their values", () => {
    const full = ownerFullWithNewField();
    const shared = shareView(full);
    expect(Object.keys(shared).sort()).toEqual([...SHARE_VIEW_FIELDS].sort());
    // Exact values (not mere presence).
    expect(shared).toEqual({
      id: "call-1",
      status: "IN_CALL",
      status_reason: null,
      ingest_degraded: false,
      created_at: "2026-01-01T00:00:00.000Z",
      ended_at: null,
      first_line_at: "2026-01-01T00:00:05.000Z",
    });
  });
});

// ── §8 / §5.16: per-tenant bot-creation guardrail → 429 SAMO-RECALL-COST ─────
describe("POST /calls — per-tenant bot-creation rate limit (§5.16 SAMO-RECALL-COST, §8)", () => {
  /**
   * A `sql` that answers the `tenants` existence probe (SELECT 1 … FROM tenants)
   * with a row, but DETONATES on `.begin` — proving a rate-rejected create never
   * reaches the INSERT (check-before-commit; a rejected create consumes no DB work).
   */
  function tenantExistsButNoCreateSql(): SQL {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tag: any = () => Promise.resolve([{ ok: 1 }]);
    tag.begin = () => {
      throw new Error("create (sql.begin) must NOT run when the tenant is over its bot-creation cap");
    };
    tag.unsafe = () => Promise.resolve([] as unknown[]);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return tag as SQL;
  }

  /**
   * A `sql` that answers the `tenants` probe AND completes the create: the calls
   * INSERT returns a PENDING row, everything else resolves empty. Used to prove a
   * tenant UNDER its cap passes the guardrail and reaches a real 201 create.
   */
  function createOkSql(): SQL {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tag: any = (strings: TemplateStringsArray) => {
      const q = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (q.includes("FROM tenants")) return Promise.resolve([{ ok: 1 }]);
      if (q.includes("INSERT INTO calls")) return Promise.resolve([{ id: "new-call-id", status: "PENDING" }]);
      return Promise.resolve([] as unknown[]);
    };
    tag.unsafe = () => Promise.resolve([] as unknown[]);
    tag.begin = async (fn: (tx: SQL) => unknown) => fn(tag as SQL);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return tag as SQL;
  }

  it("returns 429 SAMO-RECALL-COST + Retry-After and never attempts the create when the tenant is at cap", async () => {
    const now = Date.now();
    const limiter = new InMemoryRateLimiter();
    // Pre-fill this tenant's window to exactly the cap so the next create is over.
    const key = `bot-create:${TENANT_ID}`;
    for (let i = 0; i < BOT_CREATE_PER_TENANT_LIMIT; i++) {
      await limiter.hit(key, BOT_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, now);
    }

    const jobs: OrchestratorJob[] = [];
    const handler = createCallsHandler({
      sql: tenantExistsButNoCreateSql(),
      sessionSecret: SESSION_SECRET,
      enqueue: (job) => { jobs.push(job); },
      rateLimiter: limiter,
      now: () => now,
    });

    const res = await handler(
      postCalls(cookieHeader(validSessionCookie()), { meeting_url: "https://meet.google.com/abc-defg-hij" }),
    );
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe(RECALL_COST_CODE);
    expect(body.code).toBe("SAMO-RECALL-COST"); // NOT the share-scoped SAMO-RATE-001
    expect(body.retryable).toBe(true);
    expect(jobs).toEqual([]); // no enqueue on a rejected create
  });

  it("a rejected (over-cap) create does NOT consume a slot: the limiter count stays at the cap", async () => {
    const now = Date.now();
    const limiter = new InMemoryRateLimiter();
    const key = `bot-create:${TENANT_ID}`;
    for (let i = 0; i < BOT_CREATE_PER_TENANT_LIMIT; i++) {
      await limiter.hit(key, BOT_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, now);
    }
    const handler = createCallsHandler({
      sql: tenantExistsButNoCreateSql(),
      sessionSecret: SESSION_SECRET,
      enqueue: () => {},
      rateLimiter: limiter,
      now: () => now,
    });
    await handler(
      postCalls(cookieHeader(validSessionCookie()), { meeting_url: "https://meet.google.com/abc-defg-hij" }),
    );
    // Still exactly at cap (blocked peek/hit consumed nothing) — so peek is still false,
    // i.e. a rejected attempt did not push the counter to cap+1.
    expect(await limiter.peek(key, BOT_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, now)).toBe(false);
  });

  it("the guardrail is keyed PER TENANT: a different tenant at cap does not block this one", async () => {
    const now = Date.now();
    const limiter = new InMemoryRateLimiter();
    // A DIFFERENT tenant is at its cap …
    const otherTenant = "33333333-3333-4333-8333-333333333333";
    for (let i = 0; i < BOT_CREATE_PER_TENANT_LIMIT; i++) {
      await limiter.hit(`bot-create:${otherTenant}`, BOT_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, now);
    }
    // … but OUR tenant has a fresh budget, so a create is admitted past the limiter
    // and reaches a real 201 create + enqueue.
    const jobs: OrchestratorJob[] = [];
    const handler = createCallsHandler({
      sql: createOkSql(),
      sessionSecret: SESSION_SECRET,
      enqueue: (job) => { jobs.push(job); },
      rateLimiter: limiter,
      now: () => now,
    });
    const res = await handler(
      postCalls(cookieHeader(validSessionCookie()), { meeting_url: "https://meet.google.com/abc-defg-hij" }),
    );
    expect(res.status).toBe(201); // our tenant passed the guardrail — the other tenant's cap is irrelevant
    expect(jobs.length).toBe(1);
    // And OUR tenant now has exactly 1 slot consumed (the successful create), not the cap.
    expect(await limiter.peek(`bot-create:${TENANT_ID}`, BOT_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, now)).toBe(true);
  });
});
