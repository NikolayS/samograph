/**
 * Ingest bot-lifecycle → call status, pickup-latency SLO, and in-call recording
 * disclosure — `handleLifecycleEvent` (SPEC §5.2, §5.9, §5.11, §5.16; issue #79).
 *
 * Call status is driven by Recall `bot.status_change` events, NOT transcript
 * traffic: a silent call (zero `transcript.data`) must still reach `IN_CALL`.
 * This suite drives the deterministic in-repo Recall fake (lifecycle codes,
 * §6.1 — no real Recall, no tokens) plus in-memory publisher / bot-worker / clock
 * fakes.
 *
 * Pure cases (no DB) — the code→status mapping, the §5.9 consent identity (fixed
 * bot name + exact disclosure string), the `pickup_latency_ms{p50,p95,p99}`
 * percentile maths, dispatch attribution, and dispatch composition — run on every
 * PR. The persistence + pickup-SLO cases need the real `calls`/`audit_log` tables
 * + RLS + the 0002 `ingest_degraded` reset trigger and are gated on DATABASE_URL
 * (the Postgres-smoke job runs the whole suite).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { createRecallFake, type LifecycleCode } from "../../packages/test-fakes/recall/index.ts";
import { InMemoryTranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";
import { connect, setTenant } from "../../packages/shared/db/index.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { BOT_NAME } from "../bot-orchestrator/index.ts";
import { createTranscriptPipeline, inMemoryTranscriptMetrics } from "./transcriptPipeline.ts";
import { type ValidatedEvent } from "./webhook.ts";
import {
  createBotLifecycle,
  composeDispatch,
  inMemoryBotWorker,
  inMemoryBotLifecycleMetrics,
  mapLifecycleCode,
  pickupLatencyPercentiles,
  DISCLOSURE_TEXT,
  SAMO_CALL_JOIN,
  SAMO_CALL_NOREC,
  SAMO_CALL_REMOVED,
} from "./botLifecycle.ts";

const REGION = "eu-central";
const LIFECYCLE_SEED = "lifecycle";

/** A tenant-scoped `bot.status_change` ValidatedEvent straight from the fake. */
function statusEvent(
  callId: string,
  tenantId: string,
  botId: string,
  code: LifecycleCode,
  opts: { reason?: string; eventId?: string } = {},
): ValidatedEvent {
  const fake = createRecallFake({ seed: LIFECYCLE_SEED });
  return {
    kind: "bot.status_change",
    botId,
    callId,
    tenantId,
    recallEventId: opts.eventId ?? `evt-${randomUUID()}`,
    payload: fake.lifecycle(code, opts.reason ? { reason: opts.reason } : {}),
  };
}

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

// ─────────────────────────────────────────────────────────────────────────────
// Pure cases — no Postgres, no tokens.
// ─────────────────────────────────────────────────────────────────────────────
describe("mapLifecycleCode — Recall lifecycle → calls.status (§5.2/§5.16)", () => {
  it("in_call_recording → IN_CALL (non-terminal, posts disclosure, no leave)", () => {
    expect(mapLifecycleCode("in_call_recording")).toEqual({
      status: "IN_CALL",
      allowedFrom: ["PENDING", "JOINING"],
      terminal: false,
      postDisclosure: true,
      leave: false,
      persistReason: false,
      errorCode: null,
    });
  });

  it("in_call_not_recording → COULD_NOT_RECORD (terminal, leave, NO disclosure, SAMO-CALL-NOREC)", () => {
    expect(mapLifecycleCode("in_call_not_recording")).toEqual({
      status: "COULD_NOT_RECORD",
      allowedFrom: ["PENDING", "JOINING"], // pre-join only (S2-16) — never regress a LIVE IN_CALL.
      terminal: true,
      postDisclosure: false,
      leave: true,
      persistReason: false,
      errorCode: SAMO_CALL_NOREC,
    });
  });

  it("call_ended → ENDED (terminal, no leave, no disclosure)", () => {
    expect(mapLifecycleCode("call_ended")).toEqual({
      status: "ENDED",
      allowedFrom: ["PENDING", "JOINING", "IN_CALL"], // a live call CAN end.
      terminal: true,
      postDisclosure: false,
      leave: false,
      persistReason: false,
      errorCode: null,
    });
  });

  it("bot_removed → BOT_REMOVED (terminal, SAMO-CALL-REMOVED)", () => {
    expect(mapLifecycleCode("bot_removed")).toEqual({
      status: "BOT_REMOVED",
      allowedFrom: ["PENDING", "JOINING", "IN_CALL"], // a live call CAN be removed.
      terminal: true,
      postDisclosure: false,
      leave: false,
      persistReason: false,
      errorCode: SAMO_CALL_REMOVED,
    });
  });

  it("fatal → COULD_NOT_JOIN (terminal, persists Recall reason, SAMO-CALL-JOIN)", () => {
    expect(mapLifecycleCode("fatal")).toEqual({
      status: "COULD_NOT_JOIN",
      allowedFrom: ["PENDING", "JOINING"], // COULD_NOT_JOIN is pre-join-only (§5.2 / S2-16).
      terminal: true,
      postDisclosure: false,
      leave: false,
      persistReason: true,
      errorCode: SAMO_CALL_JOIN,
    });
  });

  it("an unknown lifecycle code maps to null (no-op)", () => {
    expect(mapLifecycleCode("something_else")).toBeNull();
  });

  it("the §5.16 codes are the exact stable strings", () => {
    expect(SAMO_CALL_JOIN).toBe("SAMO-CALL-JOIN");
    expect(SAMO_CALL_NOREC).toBe("SAMO-CALL-NOREC");
    expect(SAMO_CALL_REMOVED).toBe("SAMO-CALL-REMOVED");
  });
});

describe("§5.9 consent identity — fixed bot name + exact disclosure string", () => {
  it("the recording bot display name handed to Recall is the fixed BOT_NAME", () => {
    expect(BOT_NAME).toBe("samograph (recording)");
  });

  it("the disclosure chat line is byte-exact (em-dash U+2014, ASCII apostrophes)", () => {
    expect(DISCLOSURE_TEXT).toBe(
      "samograph is recording this call's audio for the host's live transcript — samograph.dev",
    );
    expect(DISCLOSURE_TEXT.includes("—")).toBe(true);
  });
});

describe("pickupLatencyPercentiles — nearest-rank p50/p95/p99 (§5.11)", () => {
  it("computes exact textbook percentiles (n=10)", () => {
    // sorted ascending: 10,20,…,100 ; nearest-rank rank = ceil(p/100 * n).
    const samples = [100, 30, 70, 10, 90, 20, 60, 40, 80, 50];
    expect(pickupLatencyPercentiles(samples)).toEqual({ p50: 50, p95: 100, p99: 100 });
  });

  it("an empty sample is all zeros", () => {
    expect(pickupLatencyPercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it("p95 ignores a tiny extreme tail but p99 surfaces it (n=200)", () => {
    const samples = Array.from({ length: 200 }, (_, i) =>
      i < 190 ? 200 : i < 199 ? 800 : 5000,
    );
    expect(pickupLatencyPercentiles(samples)).toEqual({ p50: 200, p95: 200, p99: 800 });
  });
});

describe("dispatch attribution + composition (peer to #78 on the #93 seam)", () => {
  // A tx proxy that fails the test if ANY DB work is attempted.
  const FORBIDDEN_TX = new Proxy(function () {}, {
    get() {
      throw new Error("transcript.data must not reach the lifecycle handler");
    },
    apply() {
      throw new Error("transcript.data must not reach the lifecycle handler");
    },
  }) as unknown as SQL;

  it("lifecycle.dispatch ignores transcript.data entirely (no DB, no worker, no publish)", async () => {
    const publisher = new InMemoryTranscriptPublisher();
    const worker = inMemoryBotWorker();
    const lifecycle = createBotLifecycle({
      publisher,
      worker,
      metrics: inMemoryBotLifecycleMetrics(),
    });
    const fake = createRecallFake({ seed: "attr" });

    await lifecycle.dispatch(FORBIDDEN_TX, {
      kind: "transcript.data",
      botId: fake.botId,
      callId: randomUUID(),
      tenantId: randomUUID(),
      recallEventId: "evt-attr-line",
      payload: fake.transcriptData({ words: ["hi"] }),
    });

    expect(publisher.published).toHaveLength(0);
    expect(worker.chats).toHaveLength(0);
    expect(worker.leaves).toHaveLength(0);
  });

  it("composeDispatch fans every event to each subscriber, in order, with (tx, event)", async () => {
    const seen: string[] = [];
    const tx = {} as SQL;
    const event = statusEvent(randomUUID(), randomUUID(), "bot_x", "call_ended");
    const a = composeDispatch(
      (t, e) => {
        expect(t).toBe(tx);
        expect(e).toBe(event);
        seen.push("a");
      },
      (t, e) => {
        expect(t).toBe(tx);
        expect(e).toBe(event);
        seen.push("b");
      },
    );
    await a(tx, event);
    expect(seen).toEqual(["a", "b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistence + pickup-SLO cases — need the real calls/audit_log tables + RLS +
// the 0002 ingest_degraded reset trigger (§5.10/§5.2).
// ─────────────────────────────────────────────────────────────────────────────
const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

d("handleLifecycleEvent persistence (§5.2/§5.9/§5.11/§5.16, TDD §6.2 #8)", () => {
  let sql: ReturnType<typeof connect>;
  const fake = createRecallFake({ seed: "lifecycle-db" });

  const userA = randomUUID();
  const tenantA = randomUUID();
  // A small pool of independent calls so each scenario owns a fresh row.
  const calls = Array.from({ length: 11 }, () => randomUUID());
  const botFor = (callId: string) => `bot_${callId.slice(0, 8)}`;

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${`${userA}@a.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA})`;
    for (const callId of calls) {
      await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
        VALUES (${callId}, ${tenantA}, 'https://meet.google.com/x', 'JOINING', ${REGION}, ${botFor(callId)}, 'x')`;
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM calls WHERE tenant_id = ${tenantA}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantA}`;
    await sql`DELETE FROM users WHERE id = ${userA}`;
    await sql.close();
  });

  beforeEach(async () => {
    // Reset every pooled call to a clean JOINING row with no audit history.
    await sql`UPDATE calls SET status = 'JOINING', ingest_degraded = false, ended_at = NULL, status_reason = NULL
      WHERE tenant_id = ${tenantA}`;
    await sql`DELETE FROM audit_log WHERE tenant_id = ${tenantA}`;
  });

  /** Run one lifecycle event under the call's RLS context (mirrors the #93 dispatch tx). */
  async function deliver(
    lifecycle: ReturnType<typeof createBotLifecycle>,
    tenantId: string,
    event: ValidatedEvent,
  ): Promise<void> {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      await lifecycle.handleLifecycleEvent(tx, event);
    });
  }

  const setStatus = (callId: string, status: string) =>
    sql`UPDATE calls SET status = ${status}::call_status WHERE id = ${callId}`;
  const statusOf = async (callId: string) =>
    (await sql`SELECT status FROM calls WHERE id = ${callId}`)[0].status as string;

  function newLifecycle() {
    const publisher = new InMemoryTranscriptPublisher();
    const worker = inMemoryBotWorker();
    const metrics = inMemoryBotLifecycleMetrics();
    return { lifecycle: createBotLifecycle({ publisher, worker, metrics }), publisher, worker, metrics };
  }

  it("#1 silent call: only in_call_recording (no transcript) → IN_CALL + status frame", async () => {
    const callId = calls[0];
    const { lifecycle, publisher } = newLifecycle();

    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "in_call_recording"));

    expect(await statusOf(callId)).toBe("IN_CALL");
    // No transcript was ever written — status came purely from the lifecycle event.
    const lines = await sql`SELECT count(*)::int AS c FROM transcripts WHERE call_id = ${callId}`;
    expect(lines[0].c).toBe(0);
    // A status control frame is published on the per-call channel.
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "IN_CALL" },
    ]);
  });

  it("#3 disclosure posted exactly once with the exact string; a re-delivered event never double-posts", async () => {
    const callId = calls[1];
    const { lifecycle, worker } = newLifecycle();

    // First in_call_recording: exactly one disclosure with the byte-exact string.
    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "in_call_recording"));
    expect(worker.chats).toEqual([{ callId, message: DISCLOSURE_TEXT }]);

    // A DISTINCT later in_call_recording event (status already IN_CALL): the
    // PENDING/JOINING→IN_CALL guard means no second post (the at-least-once layer
    // dedups identical events; this guard covers a re-emitted distinct one).
    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "in_call_recording"));
    expect(worker.chats).toHaveLength(1);
    expect(worker.leaves).toHaveLength(0);

    // Disclosure post is audited once (actor bot, payload_sha256 of the message).
    const disc = await sql`SELECT actor, payload_sha256 FROM audit_log
      WHERE call_id = ${callId} AND action = 'call.disclosure'`;
    expect(disc).toHaveLength(1);
    expect(disc[0].actor).toBe("bot");
    expect(disc[0].payload_sha256).toBe(sha256Hex(DISCLOSURE_TEXT));
  });

  it("#4 in_call_not_recording → COULD_NOT_RECORD, a leave, and ZERO disclosure posts", async () => {
    const callId = calls[2];
    const { lifecycle, worker, publisher } = newLifecycle();

    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "in_call_not_recording"));

    expect(await statusOf(callId)).toBe("COULD_NOT_RECORD");
    expect(worker.chats).toHaveLength(0); // NEVER a recording disclosure here (§5.9).
    expect(worker.leaves).toEqual([callId]); // clean leave via the bot-worker.
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "COULD_NOT_RECORD" },
    ]);
    // Audited: the status transition + the leave.
    const actions = (
      await sql`SELECT action FROM audit_log WHERE call_id = ${callId} ORDER BY action`
    ).map((r: { action: string }) => r.action);
    expect(actions).toEqual(["call.leave", "call.status.COULD_NOT_RECORD"]);
  });

  it("#5 bot_removed while IN_CALL → BOT_REMOVED; the 0002 trigger resets ingest_degraded", async () => {
    const callId = calls[3];
    const { lifecycle } = newLifecycle();
    await setStatus(callId, "IN_CALL");
    await sql`UPDATE calls SET ingest_degraded = true WHERE id = ${callId}`;

    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "bot_removed"));

    const row = (await sql`SELECT status, ingest_degraded, ended_at FROM calls WHERE id = ${callId}`)[0];
    expect(row.status).toBe("BOT_REMOVED");
    expect(row.ingest_degraded).toBe(false); // reset by the existing terminal trigger.
    expect(row.ended_at).not.toBeNull();
    const audit = await sql`SELECT actor, action FROM audit_log
      WHERE call_id = ${callId} AND action = 'call.status.BOT_REMOVED'`;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe("system");
  });

  it("#6 fatal before JOINING → COULD_NOT_JOIN with the Recall sub_code reason persisted", async () => {
    const callId = calls[4];
    const { lifecycle } = newLifecycle();
    await setStatus(callId, "PENDING");

    await deliver(
      lifecycle,
      tenantA,
      statusEvent(callId, tenantA, botFor(callId), "fatal", { reason: "meeting_not_found" }),
    );

    const row = (await sql`SELECT status, status_reason FROM calls WHERE id = ${callId}`)[0];
    expect(row.status).toBe("COULD_NOT_JOIN");
    expect(row.status_reason).toBe("meeting_not_found");
  });

  it("#6 out-of-order/duplicate events never regress a terminal status", async () => {
    const callId = calls[5];
    const { lifecycle, worker } = newLifecycle();

    // Reach a terminal status first.
    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "call_ended"));
    expect(await statusOf(callId)).toBe("ENDED");

    // A late in_call_recording must NOT regress ENDED → IN_CALL, and must NOT post.
    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "in_call_recording"));
    expect(await statusOf(callId)).toBe("ENDED");
    expect(worker.chats).toHaveLength(0);

    // A duplicate terminal (bot_removed) likewise leaves ENDED untouched.
    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "bot_removed"));
    expect(await statusOf(callId)).toBe("ENDED");
  });

  // ── S2-16: per-code terminal guard — a late/re-delivered terminal event must
  // NOT regress a LIVE IN_CALL row (destructive eject/mislabel). Only `call_ended`
  // and `bot_removed` may terminate a live call; `in_call_not_recording` and
  // `fatal` are pre-join-only (allowedFrom = PENDING/JOINING).
  it("S2-16 IN_CALL + in_call_not_recording → STAYS IN_CALL, NO leave, no COULD_NOT_RECORD frame", async () => {
    const callId = calls[6];
    const { lifecycle, worker, publisher } = newLifecycle();
    await setStatus(callId, "IN_CALL");

    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "in_call_not_recording"));

    // The live call is untouched — the bot is NOT ejected mid-recording.
    expect(await statusOf(callId)).toBe("IN_CALL");
    expect(worker.leaves).toHaveLength(0);
    expect(worker.chats).toHaveLength(0);
    // No status frame at all — the guarded UPDATE was a no-op.
    expect(publisher.framesFor(callId)).toEqual([]);
    // No transition audited.
    const audit = await sql`SELECT count(*)::int AS c FROM audit_log WHERE call_id = ${callId}`;
    expect(audit[0].c).toBe(0);
  });

  it("S2-16 IN_CALL + fatal → STAYS IN_CALL (never mislabelled COULD_NOT_JOIN)", async () => {
    const callId = calls[7];
    const { lifecycle, publisher } = newLifecycle();
    await setStatus(callId, "IN_CALL");

    await deliver(
      lifecycle,
      tenantA,
      statusEvent(callId, tenantA, botFor(callId), "fatal", { reason: "meeting_not_found" }),
    );

    const row = (await sql`SELECT status, status_reason FROM calls WHERE id = ${callId}`)[0];
    expect(row.status).toBe("IN_CALL");
    expect(row.status_reason).toBeNull(); // no reason persisted on a no-op.
    expect(publisher.framesFor(callId)).toEqual([]);
  });

  it("S2-16 PENDING + in_call_not_recording → COULD_NOT_RECORD + leave (pre-join escalation preserved)", async () => {
    const callId = calls[8];
    const { lifecycle, worker, publisher } = newLifecycle();
    await setStatus(callId, "PENDING");

    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "in_call_not_recording"));

    expect(await statusOf(callId)).toBe("COULD_NOT_RECORD");
    expect(worker.leaves).toEqual([callId]);
    expect(worker.chats).toHaveLength(0);
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "COULD_NOT_RECORD" },
    ]);
  });

  it("S2-16 IN_CALL + call_ended → ENDED (a live call CAN end — preserved)", async () => {
    const callId = calls[9];
    const { lifecycle, publisher } = newLifecycle();
    await setStatus(callId, "IN_CALL");

    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "call_ended"));

    expect(await statusOf(callId)).toBe("ENDED");
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "ENDED" },
    ]);
  });

  it("S2-16 IN_CALL + bot_removed → BOT_REMOVED (a live call CAN be removed — preserved)", async () => {
    const callId = calls[10];
    const { lifecycle, publisher } = newLifecycle();
    await setStatus(callId, "IN_CALL");

    await deliver(lifecycle, tenantA, statusEvent(callId, tenantA, botFor(callId), "bot_removed"));

    expect(await statusOf(callId)).toBe("BOT_REMOVED");
    expect(publisher.framesFor(callId)).toEqual([
      { type: "status", call_id: callId, status: "BOT_REMOVED" },
    ]);
  });

  it("status transitions are audited with the event payload sha256 (actor system)", async () => {
    const callId = calls[0];
    const { lifecycle } = newLifecycle();
    const event = statusEvent(callId, tenantA, botFor(callId), "in_call_recording");

    await deliver(lifecycle, tenantA, event);

    const audit = await sql`SELECT actor, payload_sha256 FROM audit_log
      WHERE call_id = ${callId} AND action = 'call.status.IN_CALL'`;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe("system");
    expect(audit[0].payload_sha256).toBe(sha256Hex(JSON.stringify(event.payload)));
  });
});

// ── Pickup-latency SLO: 200-call virtual-clock sample (§6.2 #8) ───────────────
d("pickup-latency SLO — p95 ≤ 1 s over a 200-call sample (§6.2 #8, virtual clock)", () => {
  let sql: ReturnType<typeof connect>;
  const userA = randomUUID();
  const tenantA = randomUUID();

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES (${userA}, ${`${userA}@slo.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenantA}, ${userA})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM calls WHERE tenant_id = ${tenantA}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantA}`;
    await sql`DELETE FROM users WHERE id = ${userA}`;
    await sql.close();
  });

  it("event-received → status-visible p95 ≤ 1 s across 200 calls (silent calls)", async () => {
    const N = 200;
    // 200 fresh JOINING calls, each picked up by exactly one in_call_recording.
    const ids = (
      await sql`INSERT INTO calls (tenant_id, meeting_url, status, region, recall_bot_id, ingest_secret_hash)
        SELECT ${tenantA}, 'https://meet.google.com/x', 'JOINING', ${REGION}, 'bot_slo_' || g, 'x'
        FROM generate_series(1, ${N}) g
        RETURNING id`
    ).map((r: { id: string }) => r.id);
    expect(ids).toHaveLength(N);

    // A virtual clock: per call the handler reads (received, visible); the
    // injected delta IS the recorded pickup latency, independent of real DB time.
    // Representative distribution: a fast common case (200 ms) with a small tail
    // (9× 800 ms) and one extreme outlier (5 s) — p95 must still be ≤ 1 s.
    const latencies = Array.from({ length: N }, (_, i) => (i < 190 ? 200 : i < 199 ? 800 : 5000));
    const ticks: number[] = [];
    latencies.forEach((lat, i) => {
      const received = 1_000_000 + i * 100_000;
      ticks.push(received, received + lat);
    });
    let t = 0;
    const clock = () => {
      if (t >= ticks.length) throw new Error("virtual clock exhausted");
      return ticks[t++];
    };

    const metrics = inMemoryBotLifecycleMetrics();
    const lifecycle = createBotLifecycle({
      publisher: new InMemoryTranscriptPublisher(),
      worker: inMemoryBotWorker(),
      metrics,
      clock,
    });

    for (let i = 0; i < N; i++) {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, tenantA);
        await lifecycle.handleLifecycleEvent(
          tx,
          statusEvent(ids[i], tenantA, `bot_slo_${i}`, "in_call_recording", { eventId: `evt-slo-${i}` }),
        );
      });
    }

    // Every call recorded exactly one pickup-latency sample, equal to its delta.
    expect(metrics.pickupSamples).toHaveLength(N);
    expect(metrics.pickupSamples).toEqual(latencies);

    const p = pickupLatencyPercentiles(metrics.pickupSamples);
    expect(p).toEqual({ p50: 200, p95: 200, p99: 800 });
    // The SLO: p95 ≤ 1 s, even with an 800 ms tail and a 5 s outlier present.
    expect(p.p95).toBeLessThanOrEqual(1000);
  });
});
