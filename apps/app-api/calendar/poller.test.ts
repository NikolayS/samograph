import { describe, expect, it } from "bun:test";
import { MetricsRegistry } from "../../../packages/shared/observe/registry.ts";
import { GoogleCalendarFailure } from "./google-calendar-client.ts";
import { AUTOJOIN_LEAD_MS, AUTOJOIN_LOOKBACK_MS, CALENDAR_SYNC_INTERVAL_MS, runCalendarAutoJoin, startCalendarSyncPoller } from "./poller.ts";

type Row = { id: string };

function fakeSql(rows: Row[]) {
  const sql = (() => Promise.resolve(rows)) as any;
  return sql;
}

describe("calendar sync poller", () => {
  it("auto-joins only eligible events in the lead window", async () => {
    const now = new Date("2026-08-27T12:00:00Z");
    const events = [
      { providerEventId: "lookback", meetingUrl: "https://zoom.us/j/1", startsAt: new Date(now.getTime() - AUTOJOIN_LOOKBACK_MS), endsAt: new Date(now.getTime() + 1) },
      { providerEventId: "too-old", meetingUrl: "https://zoom.us/j/6", startsAt: new Date(now.getTime() - AUTOJOIN_LOOKBACK_MS - 1), endsAt: new Date(now.getTime() + 1) },
      { providerEventId: "ended", meetingUrl: "https://zoom.us/j/7", startsAt: new Date(now.getTime() - 1), endsAt: now },
      { providerEventId: "inside", meetingUrl: "https://zoom.us/j/2", startsAt: new Date(now.getTime() + AUTOJOIN_LEAD_MS) },
      { providerEventId: "after", meetingUrl: "https://zoom.us/j/3", startsAt: new Date(now.getTime() + AUTOJOIN_LEAD_MS + 1) },
      { providerEventId: "declined", meetingUrl: "https://zoom.us/j/4", startsAt: now, attendeeResponse: "declined" as const },
      { providerEventId: "all-day", meetingUrl: "https://zoom.us/j/5", startsAt: now, allDay: true },
      { providerEventId: "linkless", meetingUrl: null, startsAt: now },
    ];
    const joined: string[] = [];
    await runCalendarAutoJoin({ id: "c1", tenantId: "t1", autoJoin: true }, {
      store: { candidates: async (_connectionId, _tenantId, current, from, to) => events.filter((event) => event.meetingUrl !== null && !event.allDay && event.attendeeResponse !== "declined" && event.startsAt >= from && event.startsAt <= to && (!event.endsAt || event.endsAt > current)) as any },
      createCall: async (input) => { joined.push(input.sourceEventId); return { kind: "created", call: { id: input.sourceEventId, status: "PENDING" } }; },
      now: () => now,
    });
    expect(joined).toEqual(["c1:lookback", "c1:inside"]);
  });

  it("uses duplicate as the idempotency path across consecutive ticks", async () => {
    const event = { providerEventId: "stable", meetingUrl: "https://zoom.us/j/1", startsAt: new Date("2026-08-27T12:01:00Z") };
    let calls = 0, bots = 0;
    const deps = {
      store: { candidates: async () => [event] }, now: () => new Date("2026-08-27T12:00:00Z"),
      createCall: async (input: any) => { expect(input.sourceEventId).toBe("c1:stable"); calls++; if (calls === 1) { bots++; return { kind: "created" as const, call: { id: "call", status: "PENDING" } }; } return { kind: "duplicate" as const }; },
    };
    await runCalendarAutoJoin({ id: "c1", tenantId: "t1", autoJoin: true }, deps);
    await runCalendarAutoJoin({ id: "c1", tenantId: "t1", autoJoin: true }, deps);
    expect({ calls, bots }).toEqual({ calls: 2, bots: 1 });
  });

  it("counts candidate-time and create-time already-active outcomes under the same label", async () => {
    const metrics = new MetricsRegistry(), warnings: string[] = [];
    let calls = 0;
    await runCalendarAutoJoin({ id: "c1", tenantId: "t1", autoJoin: true }, {
      store: { candidates: async () => [
        { providerEventId: "prefiltered", meetingUrl: "https://zoom.us/j/1", startsAt: new Date(), alreadyActive: true },
        { providerEventId: "raced", meetingUrl: "https://zoom.us/j/1", startsAt: new Date() },
      ] },
      createCall: async () => { calls++; return { kind: "already_active", callId: "active-call" }; },
      logger: { warn: (message) => warnings.push(message) },
      metrics,
    });
    expect(calls).toBe(1);
    expect(warnings).toEqual([]);
    expect(metrics.renderPrometheus()).toContain('calendar_autojoin_total{result="already_active"} 2');
  });

  it("scopes the same provider event id to its calendar connection", async () => {
    const sourceEventIds: string[] = [];
    const deps = {
      store: { candidates: async () => [{ providerEventId: "shared", meetingUrl: "https://zoom.us/j/1", startsAt: new Date() }] },
      createCall: async (input: any) => { sourceEventIds.push(input.sourceEventId); return { kind: "created" as const, call: { id: "call", status: "PENDING" } }; },
    };
    await runCalendarAutoJoin({ id: "11111111-1111-4111-8111-111111111111", tenantId: "t1", autoJoin: true }, deps);
    await runCalendarAutoJoin({ id: "22222222-2222-4222-8222-222222222222", tenantId: "t1", autoJoin: true }, deps);
    expect(sourceEventIds).toEqual([
      "11111111-1111-4111-8111-111111111111:shared",
      "22222222-2222-4222-8222-222222222222:shared",
    ]);
  });

  it("continues after cost_cap and never touches opted-out connections", async () => {
    const attempted: string[] = [], warnings: string[] = [];
    const metrics = new MetricsRegistry();
    const store = { candidates: async () => [
      { providerEventId: "capped", meetingUrl: "https://zoom.us/j/1", startsAt: new Date() },
      { providerEventId: "next", meetingUrl: "https://zoom.us/j/2", startsAt: new Date() },
    ] };
    let reads = 0;
    const deps = {
      store: { candidates: async (...args: any[]) => { reads++; return store.candidates(); } }, now: () => new Date(),
      createCall: async (input: any) => { attempted.push(input.sourceEventId); return input.sourceEventId === "c1:capped" ? { kind: "cost_cap" as const, retryAfterMs: 1 } : { kind: "created" as const, call: { id: "call", status: "PENDING" } }; },
      logger: { warn: (message: string) => warnings.push(message) },
      metrics,
    };
    await runCalendarAutoJoin({ id: "c1", tenantId: "t1", autoJoin: true }, deps);
    await runCalendarAutoJoin({ id: "c2", tenantId: "t1", autoJoin: false }, deps);
    expect(attempted).toEqual(["c1:capped", "c1:next"]);
    expect(reads).toBe(1);
    expect(warnings).toEqual(["[calendar-autojoin] connection c1 event capped result: cost_cap"]);
    expect(metrics.renderPrometheus()).toContain('calendar_autojoin_total{result="cost_cap"} 1');
    expect(metrics.renderPrometheus()).toContain('calendar_autojoin_total{result="created"} 1');
  });
  it("schedules the exact five-minute default and stop() stops it", () => {
    let interval = -1, stopped = 0;
    const poller = startCalendarSyncPoller({
      sql: fakeSql([]),
      syncConnection: async () => {},
      schedule: (_fn, ms) => { interval = ms; return { stop: () => { stopped++; } }; },
    });
    expect(CALENDAR_SYNC_INTERVAL_MS).toBe(300_000);
    expect(interval).toBe(300_000);
    poller.stop();
    expect(stopped).toBe(1);
  });

  it("passes an injected interval to the scheduler exactly", () => {
    let interval = -1;
    startCalendarSyncPoller({
      sql: fakeSql([]), syncConnection: async () => {}, intervalMs: 12_345,
      schedule: (_fn, ms) => { interval = ms; return { stop() {} }; },
    });
    expect(interval).toBe(12_345);
  });

  it("never exceeds four concurrent connections across ten rows", async () => {
    let active = 0, maximum = 0;
    const releases: Array<() => void> = [];
    const poller = startCalendarSyncPoller({
      sql: fakeSql(Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` }))),
      syncConnection: async () => {
        active++; maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
      },
      schedule: () => ({ stop() {} }),
    });
    const sweep = poller.tick();
    await Bun.sleep(0);
    expect(active).toBe(4);
    while (releases.length) { releases.shift()?.(); await Bun.sleep(0); }
    await sweep;
    expect(maximum).toBe(4);
  });

  it("makes a tick during an in-flight sweep an exact no-op", async () => {
    let selected = 0, release!: () => void;
    const sql = (() => { selected++; return Promise.resolve([{ id: "c1" }]); }) as any;
    const poller = startCalendarSyncPoller({
      sql,
      syncConnection: () => new Promise<void>((resolve) => { release = resolve; }),
      schedule: () => ({ stop() {} }),
    });
    const first = poller.tick();
    await Bun.sleep(0);
    await poller.tick();
    expect(selected).toBe(1);
    release();
    await first;
  });

  it("isolates a failed connection and logs only id plus controlled category", async () => {
    const synced: string[] = [], warnings: string[] = [];
    const poller = startCalendarSyncPoller({
      sql: fakeSql([{ id: "good-a" }, { id: "bad" }, { id: "good-b" }]),
      syncConnection: async (id) => {
        if (id === "bad") throw new GoogleCalendarFailure("transient");
        synced.push(id);
      },
      logger: { warn: (message) => warnings.push(message) },
      schedule: () => ({ stop() {} }),
    });
    await poller.tick();
    expect(synced.sort()).toEqual(["good-a", "good-b"]);
    expect(warnings).toEqual(["[calendar-poller] connection bad failed: transient"]);
  });

  it("honors Retry-After per connection without delaying the rest", async () => {
    let now = 1_000;
    const attempts: string[] = [];
    const poller = startCalendarSyncPoller({
      sql: fakeSql([{ id: "limited" }, { id: "healthy" }]), clock: () => now,
      syncConnection: async (id) => {
        attempts.push(id);
        if (id === "limited") throw new GoogleCalendarFailure("rate_limited", 5_000);
      },
      schedule: () => ({ stop() {} }),
    });
    await poller.tick();
    now = 5_999; await poller.tick();
    now = 6_000; await poller.tick();
    expect(attempts).toEqual(["limited", "healthy", "healthy", "limited", "healthy"]);
  });

  it("contains a rejected selection sweep and clears the in-flight guard", async () => {
    let selections = 0;
    const synced: string[] = [], warnings: string[] = [];
    const metrics = new MetricsRegistry();
    const sql = (() => {
      selections++;
      if (selections === 1) return Promise.reject(new Error("database secret"));
      return Promise.resolve([{ id: "recovered" }]);
    }) as any;
    const poller = startCalendarSyncPoller({
      sql, metrics,
      syncConnection: async (id) => { synced.push(id); },
      logger: { warn: (message) => warnings.push(message) },
      schedule: () => ({ stop() {} }),
    });

    await expect(poller.tick()).resolves.toBeUndefined();
    await expect(poller.tick()).resolves.toBeUndefined();
    expect(selections).toBe(3);
    expect(synced).toEqual(["recovered"]);
    expect(warnings).toEqual(["[calendar-poller] sweep failed: sweep_failed"]);
    expect(metrics.renderPrometheus()).toContain('calendar_sync_total{result="sweep_failed"} 1');
  });

  it("the scheduled callback does not emit an unhandled rejection", async () => {
    let scheduled!: () => void;
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      startCalendarSyncPoller({
        sql: (() => Promise.reject(new Error("database secret"))) as any,
        syncConnection: async () => {},
        schedule: (fn) => { scheduled = fn; return { stop() {} }; },
      });
      scheduled();
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("contains a rejecting gauge refresh and the next tick runs normally", async () => {
    let calls = 0;
    const warnings: string[] = [];
    const metrics = new MetricsRegistry();
    const sql = (() => {
      calls++;
      if (calls === 1) return Promise.resolve([]);
      if (calls === 2) return Promise.reject(new Error("database secret"));
      return Promise.resolve([]);
    }) as any;
    const poller = startCalendarSyncPoller({
      sql, metrics, syncConnection: async () => {},
      logger: { warn: (message) => warnings.push(message) },
      schedule: () => ({ stop() {} }),
    });

    await expect(poller.tick()).resolves.toBeUndefined();
    await expect(poller.tick()).resolves.toBeUndefined();
    expect(calls).toBe(4);
    expect(warnings).toEqual(["[calendar-poller] sweep failed: sweep_failed"]);
    expect(metrics.renderPrometheus()).toContain('calendar_sync_total{result="sweep_failed"} 1');
  });

  it("reports 21600 seconds for syncs at six hours and one minute", async () => {
    let calls = 0;
    const queries: string[] = [];
    const metrics = new MetricsRegistry();
    const sql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return ++calls === 1
        ? Promise.resolve([])
        : Promise.resolve([{ status: "connected", count: 2, sync_age_seconds: 21_600 }]);
    }) as any;
    const poller = startCalendarSyncPoller({ sql, metrics, syncConnection: async () => {}, schedule: () => ({ stop() {} }) });
    await poller.tick();
    expect(metrics.renderPrometheus()).toContain("calendar_sync_age_seconds 21600");
    expect(queries[1]).toContain("min(COALESCE(last_sync_at, connected_at))");
  });

  it("uses connected_at as the age reference for a connected row never synced", async () => {
    let calls = 0;
    const metrics = new MetricsRegistry();
    const sql = (() => ++calls === 1
      ? Promise.resolve([])
      : Promise.resolve([{ status: "connected", count: 1, sync_age_seconds: 43_200 }])) as any;
    const poller = startCalendarSyncPoller({ sql, metrics, syncConnection: async () => {}, schedule: () => ({ stop() {} }) });
    await poller.tick();
    expect(metrics.renderPrometheus()).toContain("calendar_sync_age_seconds 43200");
    expect(metrics.renderPrometheus()).toContain("connected_at for never-synced connections; 0 when none are connected");
  });

  it("evicts retry state for removed connections and keeps it bounded under churn", async () => {
    let selected: Row[] = [{ id: "limited" }];
    let now = 1_000;
    const attempts: string[] = [];
    const poller = startCalendarSyncPoller({
      sql: (() => Promise.resolve(selected)) as any, clock: () => now,
      syncConnection: async (id) => { attempts.push(id); throw new GoogleCalendarFailure("rate_limited", 60_000); },
      schedule: () => ({ stop() {} }),
    });
    await poller.tick();
    selected = Array.from({ length: 100 }, (_, i) => ({ id: `churn-${i}` }));
    await poller.tick();
    selected = [];
    await poller.tick();
    selected = [{ id: "limited" }];
    now = 2_000;
    await poller.tick();
    expect(attempts.filter((id) => id === "limited")).toEqual(["limited", "limited"]);
  });
});
