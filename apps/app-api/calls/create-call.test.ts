import { describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { OrchestratorJob } from "../../bot-orchestrator/index.ts";
import { InMemoryRateLimiter } from "../auth/rate-limit.ts";
import { AUTO_CREATE_PER_TENANT_LIMIT, BOT_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, createCallForTenant, type CreateCallDeps } from "./create-call.ts";

const tenantId = "22222222-2222-4222-8222-222222222222";

interface QueryRecord { query: string; values: unknown[] }

function fakeSql(
  options: { callError?: Error; activeCall?: { id: string } } = {},
  queries: QueryRecord[] = [],
): SQL {
  // Bun's SQL callable has richer Query/transaction overloads than this small
  // in-memory fake needs, so keep the fake dynamic and cast only at its edge.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tag: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    queries.push({ query, values });
    if (query.includes("FROM tenants")) return Promise.resolve([{ ok: 1 }]);
    if (query.includes("FROM calls") && query.includes("meeting_url")) {
      return Promise.resolve(options.activeCall ? [options.activeCall] : []);
    }
    if (query.includes("INSERT INTO calls")) {
      if (options.callError) return Promise.reject(options.callError);
      return Promise.resolve([{ id: "call-1", status: "PENDING" }]);
    }
    if (query.includes("FROM settings")) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  tag.unsafe = async () => [];
  tag.begin = async (fn: (tx: SQL) => Promise<unknown>) => fn(tag as SQL);
  return tag as SQL;
}

function deps(sql = fakeSql()): CreateCallDeps & { jobs: OrchestratorJob[] } {
  const jobs: OrchestratorJob[] = [];
  return {
    sql,
    rateLimiter: new InMemoryRateLimiter(),
    enqueue: (job) => { jobs.push(job); },
    now: () => 1234,
    jobs,
  };
}

if (false) {
  // @ts-expect-error manual calls cannot carry a calendar event identity
  void createCallForTenant({
    tenantId,
    actor: "user:u1",
    meetingUrl: "https://zoom.us/j/123",
    source: "manual",
    sourceEventId: "event-1",
  }, deps());
}

describe("createCallForTenant", () => {
  it("locks and returns already_active for a calendar call with an active normalized URL", async () => {
    const queries: QueryRecord[] = [];
    const d = deps(fakeSql({ activeCall: { id: "active-call" } }, queries));

    const result = await createCallForTenant({
      tenantId,
      actor: "calendar-autojoin",
      meetingUrl: " HTTPS://ZOOM.US/j/123 ",
      source: "calendar",
      sourceEventId: "connection:event-1",
    }, d);

    expect(result).toEqual({ kind: "already_active", callId: "active-call" });
    expect(queries).toContainEqual({
      query: expect.stringContaining("pg_advisory_xact_lock"),
      values: [`${tenantId}:https://zoom.us/j/123`],
    });
    expect(queries).toContainEqual({
      query: expect.stringContaining("FROM calls"),
      values: [tenantId, "https://zoom.us/j/123"],
    });
    expect(queries.some(({ query }) => query.includes("INSERT INTO calls"))).toBe(false);
    expect(d.jobs).toEqual([]);
  });

  it("locks and re-checks active calls for manual calls", async () => {
    const queries: QueryRecord[] = [];
    const d = deps(fakeSql({ activeCall: { id: "active-call" } }, queries));

    const result = await createCallForTenant({
      tenantId,
      actor: "user:u1",
      meetingUrl: "https://zoom.us/j/123",
      source: "manual",
    }, d);

    expect(result).toEqual({ kind: "already_active", callId: "active-call" });
    expect(queries).toContainEqual({
      query: expect.stringContaining("pg_advisory_xact_lock"),
      values: [`${tenantId}:https://zoom.us/j/123`],
    });
    expect(queries).toContainEqual({
      query: expect.stringContaining("FROM calls"),
      values: [tenantId, "https://zoom.us/j/123"],
    });
    expect(queries.some(({ query }) => query.includes("INSERT INTO calls"))).toBe(false);
  });

  it("creates, audits, resolves settings, and enqueues", async () => {
    const queries: QueryRecord[] = [];
    const d = deps(fakeSql({}, queries));
    const result = await createCallForTenant({
      tenantId, actor: "user:u1", meetingUrl: "https://meet.google.com/abc-defg-hij",
      source: "calendar", sourceEventId: "event-1",
    }, d);
    expect(result).toEqual({ kind: "created", call: { id: "call-1", status: "PENDING" } });
    expect(queries).toContainEqual({
      query: expect.stringContaining("INSERT INTO audit_log"),
      values: [tenantId, "call-1", "user:u1"],
    });
    expect(d.jobs).toEqual([{ callId: "call-1", meetingUrl: "https://meet.google.com/abc-defg-hij", keyterms: [], language: "multi" }]);
  });

  it("returns invalid_url before touching the database", async () => {
    const d = deps(new Proxy(() => {}, { apply() { throw new Error("db touched"); }, get() { throw new Error("db touched"); } }) as unknown as SQL);
    expect(await createCallForTenant({ tenantId, actor: "user:u1", meetingUrl: "nope", source: "manual" }, d))
      .toEqual({ kind: "invalid_url" });
  });

  it("returns cost_cap when the tenant has exhausted its budget", async () => {
    const d = deps();
    for (let i = 0; i < 30; i++) await d.rateLimiter.hit(`bot-create:${tenantId}`, 30, 3_600_000, 1234);
    const result = await createCallForTenant({ tenantId, actor: "user:u1", meetingUrl: "https://zoom.us/j/123", source: "manual" }, d);
    expect(result.kind).toBe("cost_cap");
  });

  it("keeps calendar auto-join usage out of the manual creation budget", async () => {
    const d = deps();
    let now = 1234;
    d.now = () => now;
    for (let i = 0; i < 30; i++) {
      now = 1234 + Math.floor(i / AUTO_CREATE_PER_TENANT_LIMIT) * BOT_CREATE_WINDOW_MS;
      expect((await createCallForTenant({ tenantId, actor: "calendar", meetingUrl: "https://zoom.us/j/123", source: "calendar", sourceEventId: `connection:event-${i}` }, d)).kind).toBe("created");
    }
    expect((await createCallForTenant({ tenantId, actor: "user:u1", meetingUrl: "https://zoom.us/j/123", source: "manual" }, d)).kind).toBe("created");
    expect(await d.rateLimiter.peek(`bot-create:${tenantId}`, BOT_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, now)).toBe(true);
  });

  it("caps the eleventh calendar auto-join creation in an hour", async () => {
    const d = deps();
    for (let i = 0; i < AUTO_CREATE_PER_TENANT_LIMIT; i++) {
      expect((await createCallForTenant({ tenantId, actor: "calendar", meetingUrl: "https://zoom.us/j/123", source: "calendar", sourceEventId: `connection:event-${i}` }, d)).kind).toBe("created");
    }
    expect((await createCallForTenant({ tenantId, actor: "calendar", meetingUrl: "https://zoom.us/j/123", source: "calendar", sourceEventId: "connection:event-11" }, d)).kind).toBe("cost_cap");
  });

  it("returns duplicate for a repeated source event and refunds the cost slot", async () => {
    const duplicate = Object.assign(new Error("duplicate"), {
      errno: "23505",
      constraint: "calls_tenant_source_event_unique_idx",
    });
    const d = deps(fakeSql({ callError: duplicate }));
    const result = await createCallForTenant({ tenantId, actor: "calendar", meetingUrl: "https://zoom.us/j/123", source: "calendar", sourceEventId: "event-1" }, d);
    expect(result).toEqual({ kind: "duplicate" });
    expect(await d.rateLimiter.peek(`bot-create:auto:${tenantId}`, AUTO_CREATE_PER_TENANT_LIMIT, BOT_CREATE_WINDOW_MS, 1234)).toBe(true);
    expect(d.jobs).toEqual([]);
  });

  it("rethrows a unique violation from an unrelated constraint and does not enqueue", async () => {
    const unrelated = Object.assign(new Error("duplicate"), {
      errno: "23505",
      constraint: "calls_pkey",
    });
    const d = deps(fakeSql({ callError: unrelated }));

    await expect(createCallForTenant({
      tenantId, actor: "calendar", meetingUrl: "https://zoom.us/j/123",
      source: "calendar", sourceEventId: "event-1",
    }, d)).rejects.toBe(unrelated);
    expect(d.jobs).toEqual([]);
  });
});
