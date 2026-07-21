/**
 * Recall bot-STATUS POLLER — `startStatusPoller` (SPEC §5.2; issue #118).
 *
 * Real Recall does NOT deliver `bot.status_change` on the realtime transcript
 * endpoint (rejected with HTTP 400 — see `recallClient.ts`), so live calls stick
 * at JOINING forever. The poller sweeps every non-terminal call that has a
 * `recall_bot_id`, asks a {@link BotStatusSource} for the bot's `status_changes`,
 * maps the LATEST code onto our `calls.status`, and applies it as a FORWARD-ONLY
 * conditional UPDATE (a terminal status is sticky; IN_CALL never regresses to
 * JOINING).
 *
 * Pure cases (no DB): the table-driven code→CallStatus mapping (exact, per the
 * Recall API codes), latest-change selection, the in-repo fake source, and the
 * watchdog-style scheduler seam (injectable interval, bounded, stoppable, no
 * overlapping ticks). They run on every PR — no RECALL_API_KEY, no network.
 *
 * Persistence cases are gated on DATABASE_URL (the Postgres-smoke job runs the
 * whole suite): one poll advances a JOINING call to IN_CALL, the next to ENDED,
 * and a stale later poll can never regress the terminal row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../packages/shared/db/index.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createFakeBotStatusSource } from "../../packages/test-fakes/recall/index.ts";
import { InMemoryTranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";
import { DISCLOSURE_TEXT } from "../ingest/botLifecycle.ts";
import type { BotActions } from "./recallBotActions.ts";
import { inMemoryBotJoinMetrics } from "./botJoinMetrics.ts";
import { MetricsRegistry } from "../../packages/shared/observe/registry.ts";
import {
  mapPolledCode,
  latestChange,
  liveBotStatusSource,
  resolvePolledTransition,
  startStatusPoller,
  NOT_RECORDING_GRACE_MS,
  STATUS_POLL_INTERVAL_MS,
  type PolledCallStatus,
  type StatusChange,
} from "./statusPoller.ts";

/** Bot-act spy (§5.9): records every chat/leave; can fail the next chat. */
function spyActions(): BotActions & {
  chats: Array<{ botId: string; message: string }>;
  leaves: string[];
  failNextChat: Error | null;
} {
  const spy = {
    chats: [] as Array<{ botId: string; message: string }>,
    leaves: [] as string[],
    failNextChat: null as Error | null,
    async sendChat(botId: string, message: string) {
      if (spy.failNextChat) {
        const err = spy.failNextChat;
        spy.failNextChat = null;
        throw err;
      }
      spy.chats.push({ botId, message });
    },
    async leave(botId: string) {
      spy.leaves.push(botId);
    },
    async deleteRecording() {},
  };
  return spy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the Recall code → calls.status mapping (issue #118, exact + table-driven)
// ─────────────────────────────────────────────────────────────────────────────
describe("mapPolledCode (Recall status_changes code → calls.status)", () => {
  const TABLE: Array<[code: string, expected: PolledCallStatus | null]> = [
    ["in_call_recording", "IN_CALL"],
    ["call_ended", "ENDED"],
    ["recording_done", "ENDED"],
    ["done", "ENDED"],
    ["recording_permission_denied", "COULD_NOT_RECORD"],
    ["joining_call", "JOINING"],
    ["in_waiting_room", "JOINING"],
    ["in_call_not_recording", "JOINING"],
    ["fatal", "COULD_NOT_JOIN"],
    ["error", "COULD_NOT_JOIN"],
    // Unknown / future Recall codes are a no-op, never a crash.
    ["ready", null],
    ["media_expired", null],
    ["", null],
  ];

  for (const [code, expected] of TABLE) {
    it(`maps ${JSON.stringify(code)} → ${expected === null ? "null (no-op)" : expected}`, () => {
      expect(mapPolledCode(code)).toBe(expected);
    });
  }
});

describe("latestChange (pick the newest status_changes entry)", () => {
  it("returns null for an empty list", () => {
    expect(latestChange([])).toBeNull();
  });

  it("picks the entry with the greatest created_at regardless of array order", () => {
    const changes: StatusChange[] = [
      { code: "in_call_recording", sub_code: null, created_at: "2026-07-01T10:00:05Z" },
      { code: "joining_call", sub_code: null, created_at: "2026-07-01T10:00:01Z" },
      { code: "call_ended", sub_code: null, created_at: "2026-07-01T10:00:09Z" },
    ];
    expect(latestChange(changes)).toEqual({
      code: "call_ended",
      sub_code: null,
      created_at: "2026-07-01T10:00:09Z",
    });
  });

  it("ties / missing created_at → the LAST array entry wins (Recall appends chronologically)", () => {
    const changes: StatusChange[] = [
      { code: "joining_call", sub_code: null },
      { code: "in_call_recording", sub_code: null },
    ];
    expect(latestChange(changes)?.code).toBe("in_call_recording");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure: resolvePolledTransition — the §5.9 side-effect mapping over the history
// ─────────────────────────────────────────────────────────────────────────────
describe("resolvePolledTransition (§5.9: disclosure / clean-leave over the polled history)", () => {
  const NOW = Date.parse("2026-07-01T10:01:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("in_call_recording → IN_CALL with the disclosure post (never a leave)", () => {
    expect(
      resolvePolledTransition({ code: "in_call_recording", created_at: iso(NOW - 1000) }, NOW),
    ).toEqual({ status: "IN_CALL", postDisclosure: true, leave: false });
  });

  it("a FRESH in_call_not_recording is the transient pre-recording hop → JOINING, no side effects", () => {
    expect(
      resolvePolledTransition({ code: "in_call_not_recording", created_at: iso(NOW - 5_000) }, NOW),
    ).toEqual({ status: "JOINING", postDisclosure: false, leave: false });
  });

  it("in_call_not_recording older than the grace → COULD_NOT_RECORD + clean leave, NO disclosure (§5.9)", () => {
    expect(
      resolvePolledTransition(
        { code: "in_call_not_recording", created_at: iso(NOW - NOT_RECORDING_GRACE_MS) },
        NOW,
      ),
    ).toEqual({ status: "COULD_NOT_RECORD", postDisclosure: false, leave: true });
    expect(NOT_RECORDING_GRACE_MS).toBe(30_000);
  });

  it("a missing/malformed created_at can never destroy the call (stays the JOINING hop)", () => {
    expect(resolvePolledTransition({ code: "in_call_not_recording" }, NOW)).toEqual({
      status: "JOINING",
      postDisclosure: false,
      leave: false,
    });
    expect(
      resolvePolledTransition({ code: "in_call_not_recording", created_at: "not-a-date" }, NOW),
    ).toEqual({ status: "JOINING", postDisclosure: false, leave: false });
  });

  it("every other code maps via mapPolledCode with no side effects; unknown stays null", () => {
    expect(resolvePolledTransition({ code: "call_ended" }, NOW)).toEqual({
      status: "ENDED",
      postDisclosure: false,
      leave: false,
    });
    expect(resolvePolledTransition({ code: "joining_call" }, NOW)).toEqual({
      status: "JOINING",
      postDisclosure: false,
      leave: false,
    });
    expect(resolvePolledTransition({ code: "media_expired" }, NOW)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the in-repo fake BotStatusSource (§6.1 — no key, no network)
// ─────────────────────────────────────────────────────────────────────────────
describe("createFakeBotStatusSource (in-repo fake, packages/test-fakes/recall)", () => {
  it("returns [] for an unknown bot and the scripted changes for a known one", async () => {
    const fake = createFakeBotStatusSource();
    expect(await fake.getStatus("bot_missing")).toEqual([]);

    fake.push("bot_1", "joining_call");
    fake.push("bot_1", "in_call_recording");
    const changes = await fake.getStatus("bot_1");
    expect(changes.map((c) => c.code)).toEqual(["joining_call", "in_call_recording"]);
    // Deterministic, monotonically increasing created_at (byte-stable, no wall clock).
    expect(changes[0].created_at! < changes[1].created_at!).toBe(true);
  });

  it("carries sub_code and supports scripted failures per bot", async () => {
    const fake = createFakeBotStatusSource();
    fake.push("bot_2", "fatal", { subCode: "meeting_not_found" });
    expect((await fake.getStatus("bot_2"))[0].sub_code).toBe("meeting_not_found");

    fake.fail("bot_down", new Error("recall 500"));
    await expect(fake.getStatus("bot_down")).rejects.toThrow("recall 500");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the LIVE source parses the real GET /api/v1/bot/<id>/ response shape
// (fetch injected — no network, no key material anywhere near this test).
// ─────────────────────────────────────────────────────────────────────────────
describe("liveBotStatusSource (real Recall GET /bot/:id/, injected fetch)", () => {
  // Obviously-fake key: the env is INJECTED — no real RECALL_API_KEY anywhere.
  const env = { RECALL_API_KEY: "test-not-a-real-key" };

  it("extracts status_changes from the bot payload and drops malformed entries", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const source = liveBotStatusSource({
      env,
      fetch: async (url, init) => {
        seen.push({
          url,
          auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
        });
        return new Response(
          JSON.stringify({
            id: "bot_abc",
            status_changes: [
              { code: "joining_call", sub_code: null, created_at: "2026-07-01T10:00:01Z" },
              { code: "in_call_recording", sub_code: null, created_at: "2026-07-01T10:00:05Z" },
              { nope: true },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const changes = await source.getStatus("bot_abc");
    expect(changes.map((c) => c.code)).toEqual(["joining_call", "in_call_recording"]);
    expect(seen).toEqual([
      {
        url: "https://us-east-1.recall.ai/api/v1/bot/bot_abc/",
        auth: "Token test-not-a-real-key",
      },
    ]);
  });

  it("returns [] when the payload has no status_changes array", async () => {
    const source = liveBotStatusSource({
      env,
      fetch: async () => new Response(JSON.stringify({ id: "bot_abc" }), { status: 200 }),
    });
    expect(await source.getStatus("bot_abc")).toEqual([]);
  });

  it("refuses to poll without a key and never echoes the response body on HTTP errors", async () => {
    const noKey = liveBotStatusSource({ env: {}, fetch: async () => new Response("{}") });
    await expect(noKey.getStatus("bot_abc")).rejects.toThrow("RECALL_API_KEY is not set");

    const http500 = liveBotStatusSource({
      env,
      fetch: async () => new Response("secret-ish body", { status: 500 }),
    });
    await expect(http500.getStatus("bot_abc")).rejects.toThrow("get bot status failed: HTTP 500");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the watchdog-style scheduler seam (bounded, injectable, no overlap)
// ─────────────────────────────────────────────────────────────────────────────
describe("startStatusPoller scheduler seam", () => {
  it("schedules tick at the injected interval (default 10s) and stop() stops it", () => {
    const scheduled: Array<{ ms: number }> = [];
    let stopped = 0;
    const poller = startStatusPoller({
      // Never touched: the schedule fake never fires the tick.
      sql: null as never,
      source: createFakeBotStatusSource(),
      actions: spyActions(),
      schedule: (_fn, ms) => {
        scheduled.push({ ms });
        return { stop: () => (stopped += 1) };
      },
    });
    expect(scheduled).toEqual([{ ms: STATUS_POLL_INTERVAL_MS }]);
    expect(STATUS_POLL_INTERVAL_MS).toBe(10_000);
    poller.stop();
    expect(stopped).toBe(1);
  });

  it("never overlaps ticks: a tick while one is in flight is a no-op", async () => {
    let selects = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    // Minimal sql stub: count TAG invocations only (sql(array) IN-list helper
    // calls are not queries); the sweep's SELECT blocks until we release it.
    const sql = (async (first: unknown, ..._rest: unknown[]) => {
      if (!Array.isArray(first) || !("raw" in (first as object))) return [];
      selects += 1;
      await gate;
      return [];
    }) as never;

    const poller = startStatusPoller({
      sql,
      source: createFakeBotStatusSource(),
      actions: spyActions(),
      schedule: () => ({ stop() {} }),
    });

    const first = poller.tick();
    await poller.tick(); // in-flight guard → resolves immediately, no second SELECT
    expect(selects).toBe(1);
    release?.();
    await first;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — needs the real calls table (+ enum + triggers); DATABASE_URL-gated.
// ─────────────────────────────────────────────────────────────────────────────
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("startStatusPoller persistence (issue #118: JOINING → IN_CALL → ENDED, forward-only)", () => {
  let sql: ReturnType<typeof connect>;
  const userA = randomUUID();
  const tenantA = randomUUID();
  const calls = Array.from({ length: 4 }, () => randomUUID());
  const botFor = (callId: string) => `bot_${callId.slice(0, 8)}`;

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${`${userA}@a.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA})`;
    for (const callId of calls) {
      await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
        VALUES (${callId}, ${tenantA}, 'https://meet.google.com/x', 'JOINING', 'eu-central', ${botFor(callId)}, 'x')`;
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM calls WHERE tenant_id = ${tenantA}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantA}`;
    await sql`DELETE FROM users WHERE id = ${userA}`;
    await sql.close();
  });

  beforeEach(async () => {
    await sql`UPDATE calls SET status = 'JOINING', ended_at = NULL, status_reason = NULL,
      disclosure_posted_at = NULL WHERE tenant_id = ${tenantA}`;
  });

  const statusOf = async (callId: string) =>
    (await sql`SELECT status FROM calls WHERE id = ${callId}`)[0].status as string;
  const setStatus = (callId: string, status: string) =>
    sql`UPDATE calls SET status = ${status}::call_status WHERE id = ${callId}`;

  function newPoller(source = createFakeBotStatusSource()) {
    // schedule stub: tests drive tick() directly (no real timers).
    const actions = spyActions();
    const poller = startStatusPoller({ sql, source, actions, schedule: () => ({ stop() {} }) });
    return { poller, source, actions };
  }

  it("one poll advances JOINING → IN_CALL, the next → ENDED (with ended_at stamped)", async () => {
    const callId = calls[0];
    const bot = botFor(callId);
    const { poller, source } = newPoller();

    // Recall reports the bot recording → one tick moves the call to IN_CALL.
    source.push(bot, "joining_call");
    source.push(bot, "in_call_recording");
    await poller.tick();
    expect(await statusOf(callId)).toBe("IN_CALL");

    // The call ends on Recall's side → the next tick moves it to ENDED.
    source.push(bot, "call_ended");
    await poller.tick();
    expect(await statusOf(callId)).toBe("ENDED");
    const row = (await sql`SELECT ended_at FROM calls WHERE id = ${callId}`)[0] as {
      ended_at: Date | null;
    };
    expect(row.ended_at).not.toBeNull();

    // A later stale poll (Recall history still ends in call_ended; or lagging
    // caches replay in_call_recording) can NEVER regress the terminal status.
    source.set(bot, [{ code: "in_call_recording", sub_code: null, created_at: "2099-01-01T00:00:00Z" }]);
    await poller.tick();
    expect(await statusOf(callId)).toBe("ENDED");
  });

  it("forward-only within non-terminal: IN_CALL never regresses to JOINING", async () => {
    const callId = calls[1];
    const { poller, source } = newPoller();
    await setStatus(callId, "IN_CALL");

    source.push(botFor(callId), "in_waiting_room"); // maps to JOINING — behind IN_CALL
    await poller.tick();
    expect(await statusOf(callId)).toBe("IN_CALL");
  });

  it("PENDING advances to JOINING; fatal persists status_reason from sub_code", async () => {
    const joinCall = calls[1];
    const fatalCall = calls[2];
    const { poller, source } = newPoller();
    await setStatus(joinCall, "PENDING");

    source.push(botFor(joinCall), "joining_call");
    source.push(botFor(fatalCall), "fatal", { subCode: "meeting_not_found" });
    await poller.tick();

    expect(await statusOf(joinCall)).toBe("JOINING");
    expect(await statusOf(fatalCall)).toBe("COULD_NOT_JOIN");
    const reason = (await sql`SELECT status_reason FROM calls WHERE id = ${fatalCall}`)[0] as {
      status_reason: string | null;
    };
    expect(reason.status_reason).toBe("meeting_not_found");
  });

  it("recording_permission_denied persists COULD_NOT_RECORD with status_reason from sub_code", async () => {
    const callId = calls[3];
    const { poller, source } = newPoller();

    source.push(botFor(callId), "recording_permission_denied", {
      subCode: "recording_permission_denied_by_host",
    });
    await poller.tick();

    expect(await statusOf(callId)).toBe("COULD_NOT_RECORD");
    const row = (await sql`
      SELECT status_reason, ended_at FROM calls WHERE id = ${callId}`)[0] as {
      status_reason: string | null;
      ended_at: Date | null;
    };
    expect(row.status_reason).toBe("recording_permission_denied_by_host");
    expect(row.ended_at).not.toBeNull();
  });

  // ── §5.11 bot_join_total{result} producer (issue #107) ────────────────────
  // The poller is the ONLY producer of the `in_call` outcome (the orchestrator
  // stops at JOINING). Emit EXACTLY once per call on the forward-only terminal
  // transition; a repeat poll (same history) matches 0 rows → never double-counts.

  it("the JOINING → IN_CALL transition increments bot_join_total{in_call} EXACTLY once, and repeated polls keep it at 1", async () => {
    const callId = calls[0];
    const bot = botFor(callId);
    const source = createFakeBotStatusSource();
    const metrics = inMemoryBotJoinMetrics();
    const poller = startStatusPoller({
      sql,
      source,
      actions: spyActions(),
      metrics,
      schedule: () => ({ stop() {} }),
    });

    source.push(bot, "in_call_recording");
    await poller.tick();
    expect(await statusOf(callId)).toBe("IN_CALL");
    expect(metrics.get("in_call")).toBe(1);

    // Same Recall history on the next two sweeps → forward-only UPDATE matches
    // 0 rows → the counter must STAY at 1 (no double-count from duplicate polls).
    await poller.tick();
    await poller.tick();
    expect(metrics.get("in_call")).toBe(1);
    expect(metrics.get("could_not_join")).toBe(0);
    expect(metrics.get("could_not_record")).toBe(0);
  });

  it("a fatal transition increments bot_join_total{could_not_join} once; permission-denied increments {could_not_record} once", async () => {
    const fatalCall = calls[1];
    const denyCall = calls[2];
    const source = createFakeBotStatusSource();
    const metrics = inMemoryBotJoinMetrics();
    const poller = startStatusPoller({
      sql,
      source,
      actions: spyActions(),
      metrics,
      schedule: () => ({ stop() {} }),
    });

    source.push(botFor(fatalCall), "fatal", { subCode: "meeting_not_found" });
    source.push(botFor(denyCall), "recording_permission_denied", {
      subCode: "recording_permission_denied_by_host",
    });
    await poller.tick();
    expect(await statusOf(fatalCall)).toBe("COULD_NOT_JOIN");
    expect(await statusOf(denyCall)).toBe("COULD_NOT_RECORD");
    expect(metrics.get("could_not_join")).toBe(1);
    expect(metrics.get("could_not_record")).toBe(1);

    // Sticky terminal rows: another sweep with the same history changes nothing.
    await poller.tick();
    expect(metrics.get("could_not_join")).toBe(1);
    expect(metrics.get("could_not_record")).toBe(1);
  });

  it("the shared MetricsRegistry is a drop-in producer and renders the incremented bot_join_total line", async () => {
    const callId = calls[3];
    const registry = new MetricsRegistry();
    const source = createFakeBotStatusSource();
    const poller = startStatusPoller({
      sql,
      source,
      actions: spyActions(),
      metrics: registry,
      schedule: () => ({ stop() {} }),
    });
    source.push(botFor(callId), "in_call_recording");
    await poller.tick();
    expect(registry.get("bot_join_total", "in_call")).toBe(1);
    expect(registry.renderPrometheus()).toContain('bot_join_total{result="in_call"} 1');
  });

  it("a failing bot lookup is isolated: other calls in the same sweep still advance", async () => {
    const okCall = calls[0];
    const downCall = calls[3];
    const { poller, source } = newPoller();

    source.fail(botFor(downCall), new Error("recall 500"));
    source.push(botFor(okCall), "in_call_recording");
    await poller.tick(); // must not throw

    expect(await statusOf(okCall)).toBe("IN_CALL");
    expect(await statusOf(downCall)).toBe("JOINING"); // untouched, retried next tick
  });

  it("terminal calls are not even swept (no source lookups for them)", async () => {
    const callId = calls[0];
    await sql`UPDATE calls SET status = 'ENDED' WHERE tenant_id = ${tenantA}`;
    const lookups: string[] = [];
    const source = {
      getStatus: async (botId: string): Promise<StatusChange[]> => {
        lookups.push(botId);
        return [];
      },
    };
    const poller = startStatusPoller({
      sql,
      source,
      actions: spyActions(),
      schedule: () => ({ stop() {} }),
    });
    await poller.tick();
    expect(lookups).toEqual([]);
    expect(await statusOf(callId)).toBe("ENDED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — §5.9 disclosure chat + live status frames (#106/#117).
// The status flip / leave / status-frame ride ONE forward-only tx (a repeat poll
// matches zero rows). The recording disclosure is the exception: a non-idempotent
// external POST, sent OUTSIDE the tx and guarded by the durable
// `disclosure_posted_at` marker, so a post-send rollback never re-posts it every
// sweep, and a live IN_CALL row can never be regressed to COULD_NOT_RECORD.
// ─────────────────────────────────────────────────────────────────────────────
d("statusPoller §5.9 disclosure + live status publish (#106/#117)", () => {
  let sql: ReturnType<typeof connect>;
  const userA = randomUUID();
  const tenantA = randomUUID();
  const calls = Array.from({ length: 6 }, () => randomUUID());
  const botFor = (callId: string) => `bot_${callId.slice(0, 8)}`;

  // Deterministic wall clock for the in_call_not_recording grace (§5.9).
  const NOW = Date.parse("2026-07-01T10:01:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${`${userA}@a.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA})`;
    for (const callId of calls) {
      await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
        VALUES (${callId}, ${tenantA}, 'https://meet.google.com/x', 'JOINING', 'eu-central', ${botFor(callId)}, 'x')`;
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM calls WHERE tenant_id = ${tenantA}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantA}`;
    await sql`DELETE FROM users WHERE id = ${userA}`;
    await sql.close();
  });

  const statusOf = async (callId: string) =>
    (await sql`SELECT status FROM calls WHERE id = ${callId}`)[0].status as string;
  const auditCount = async (callId: string, action: string) =>
    Number(
      (await sql`SELECT count(*)::int AS n FROM audit_log
        WHERE call_id = ${callId} AND action = ${action}`)[0].n,
    );

  function newPoller() {
    const source = createFakeBotStatusSource();
    const actions = spyActions();
    const publisher = new InMemoryTranscriptPublisher();
    const poller = startStatusPoller({
      sql,
      source,
      actions,
      publisher,
      clock: () => NOW,
      schedule: () => ({ stop() {} }),
    });
    return { poller, source, actions, publisher };
  }

  it("a status change publishes exactly ONE {type:'status'} frame; an unchanged poll publishes nothing", async () => {
    const callId = calls[0];
    const bot = botFor(callId);
    const { poller, source, publisher } = newPoller();

    source.push(bot, "in_call_recording");
    await poller.tick();
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "IN_CALL" },
    ]);

    await poller.tick(); // same history — no new frame
    expect(publisher.framesFor(callId)).toHaveLength(1);

    source.push(bot, "call_ended");
    await poller.tick();
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "IN_CALL" },
      { type: "status", call_id: callId, status: "ENDED" },
    ]);
  });

  it("the IN_CALL transition posts the byte-exact §5.9 disclosure EXACTLY once across repeated polls", async () => {
    const callId = calls[1];
    const bot = botFor(callId);
    const { poller, source, actions } = newPoller();

    source.push(bot, "joining_call");
    source.push(bot, "in_call_recording");
    await poller.tick();
    await poller.tick();
    await poller.tick(); // repeat polls with the same Recall history

    expect(actions.chats).toEqual([
      {
        botId: bot,
        message:
          "samograph is recording this call's audio for the host's live transcript — samograph.dev",
      },
    ]);
    expect(actions.chats[0].message).toBe(DISCLOSURE_TEXT);
    expect(actions.leaves).toEqual([]);
    expect(await auditCount(callId, "call.disclosure")).toBe(1);
    expect(await auditCount(callId, "call.status.IN_CALL")).toBe(1);
  });

  it("in_call_not_recording past the grace posts NOTHING, leaves cleanly ONCE, lands COULD_NOT_RECORD", async () => {
    const callId = calls[2];
    const bot = botFor(callId);
    const { poller, source, actions, publisher } = newPoller();

    source.set(bot, [
      { code: "in_call_not_recording", sub_code: null, created_at: iso(NOW - 60_000) },
    ]);
    await poller.tick();
    await poller.tick(); // repeat poll — terminal row is no longer swept

    expect(await statusOf(callId)).toBe("COULD_NOT_RECORD");
    expect(actions.chats).toEqual([]); // NO disclosure — it would be factually wrong (§5.9)
    expect(actions.leaves).toEqual([bot]);
    expect(await auditCount(callId, "call.leave")).toBe(1);
    expect(await auditCount(callId, "call.disclosure")).toBe(0);
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "COULD_NOT_RECORD" },
    ]);
    const row = (await sql`SELECT ended_at FROM calls WHERE id = ${callId}`)[0] as {
      ended_at: Date | null;
    };
    expect(row.ended_at).not.toBeNull();
  });

  it("a FRESH in_call_not_recording is a transient hop: stays non-terminal, no leave, no chat", async () => {
    const callId = calls[3];
    const bot = botFor(callId);
    await sql`UPDATE calls SET status = 'PENDING' WHERE id = ${callId}`;
    const { poller, source, actions } = newPoller();

    source.set(bot, [
      { code: "in_call_not_recording", sub_code: null, created_at: iso(NOW - 5_000) },
    ]);
    await poller.tick();

    expect(await statusOf(callId)).toBe("JOINING"); // PENDING advanced to the hop, not killed
    expect(actions.chats).toEqual([]);
    expect(actions.leaves).toEqual([]);
  });

  it("a failed disclosure post does NOT roll back the committed IN_CALL status; it retries independently, exactly one chat", async () => {
    const callId = calls[4];
    const bot = botFor(callId);
    const { poller, source, actions, publisher } = newPoller();

    source.push(bot, "in_call_recording");
    actions.failNextChat = new Error("recall 500");
    await poller.tick(); // status flip COMMITS; the disclosure send (outside the tx) throws

    // The status is durable — a flaky disclosure never regresses the call to JOINING.
    expect(await statusOf(callId)).toBe("IN_CALL");
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "IN_CALL" },
    ]);
    expect(await auditCount(callId, "call.status.IN_CALL")).toBe(1);
    expect(await auditCount(callId, "call.disclosure")).toBe(0); // not sent yet

    await poller.tick(); // marker still unset → the disclosure retries and succeeds
    expect(actions.chats).toEqual([{ botId: bot, message: DISCLOSURE_TEXT }]);
    expect(await auditCount(callId, "call.disclosure")).toBe(1);
    expect(await auditCount(callId, "call.status.IN_CALL")).toBe(1); // status flipped only once
  });

  it("an aged in_call_not_recording NEVER regresses a live IN_CALL call to COULD_NOT_RECORD or ejects the bot (gate regression fix)", async () => {
    const callId = calls[5];
    const bot = botFor(callId);
    await sql`UPDATE calls SET status = 'IN_CALL' WHERE id = ${callId}`;
    const { poller, source, actions, publisher } = newPoller();

    // Recording stopped mid-call: Recall re-reports in_call_not_recording, aged past the grace.
    source.set(bot, [
      { code: "in_call_not_recording", sub_code: null, created_at: iso(NOW - 60_000) },
    ]);
    await poller.tick();

    expect(await statusOf(callId)).toBe("IN_CALL"); // untouched — recording DID start
    expect(actions.leaves).toEqual([]); // bot NOT kicked out of the live call
    expect(publisher.framesFor(callId)).toEqual([]); // no bogus COULD_NOT_RECORD frame
    const row = (await sql`SELECT ended_at FROM calls WHERE id = ${callId}`)[0] as {
      ended_at: Date | null;
    };
    expect(row.ended_at).toBeNull(); // not terminated
  });
});
