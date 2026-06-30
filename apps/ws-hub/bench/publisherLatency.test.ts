import { describe, expect, test } from "bun:test";
import { Hub } from "../hub.ts";
import { mulberry32 } from "./bootstrap.ts";
import {
  runPublisherLatencyBenchmark,
  runBenchOrSkip,
  ISOLATED_LABEL,
  PUBLISHER_LATENCY_SLO_MS,
  type BenchResult,
} from "./publisherLatency.ts";

/**
 * §6.2 #3 — WS publisher-latency SLO benchmark over the merged hub CORE
 * (`apps/ws-hub/hub.ts`). 1 healthy + k stalled subscribers at queue-full in
 * ONE call_id; publisher-side per-message latency → HDR histogram; p99 reported
 * with a 95 % bootstrap CI; PASS iff CI upper ≤ 5 ms. SKIPS LOUDLY (non-asserting)
 * off the single-tenant isolated runner so it never flakes on shared CI.
 */

/** A scripted clock: yields before/after timestamps (µs) so latency = after-before. */
function scriptedClock(latenciesUs: number[]): () => number {
  const seq: number[] = [];
  latenciesUs.forEach((lat, i) => {
    const base = i * 1_000_000;
    seq.push(base, base + lat);
  });
  let idx = 0;
  return () => seq[idx++]!;
}

describe("runPublisherLatencyBenchmark — §6.2 #3", () => {
  test("PASS when the injected p99 tail is under the 5 ms SLO", () => {
    const measure = 200;
    const lat: number[] = [];
    for (let i = 0; i < measure; i++) lat.push(i < 198 ? 1000 : 4000); // mostly 1 ms, tail 4 ms
    const res = runPublisherLatencyBenchmark({
      k: 4,
      warmup: 300,
      measure,
      clock: scriptedClock(lat),
      rng: mulberry32(9),
      resamples: 300,
    });
    expect(res.count).toBe(measure);
    expect(res.pass).toBe(true);
    expect(res.ciUpperMs).toBeLessThanOrEqual(PUBLISHER_LATENCY_SLO_MS);
    expect(res.p99Ms).toBeGreaterThan(0);
  });

  test("FAIL when the injected tail breaches the 5 ms SLO", () => {
    const measure = 400;
    const lat: number[] = [];
    for (let i = 0; i < measure; i++) lat.push(i < 360 ? 1000 : 9000); // 10 % at 9 ms
    const res = runPublisherLatencyBenchmark({
      k: 4,
      warmup: 300,
      measure,
      clock: scriptedClock(lat),
      rng: mulberry32(9),
      resamples: 300,
    });
    expect(res.pass).toBe(false);
    expect(res.ciUpperMs).toBeGreaterThan(PUBLISHER_LATENCY_SLO_MS);
  });

  test("drives k ∈ {1,4,16,32} to completion with strict channel isolation", () => {
    for (const k of [1, 4, 16, 32]) {
      const hub = new Hub();
      // Probe on a DIFFERENT call_id must receive nothing (isolation, §5.5).
      const probe = hub.subscribe("other-call");
      const res = runPublisherLatencyBenchmark({
        k,
        warmup: 5,
        measure: 30,
        hub,
        callId: "bench-call",
      });
      expect(res.k).toBe(k);
      expect(res.count).toBe(30);
      expect(probe.queueDepth()).toBe(0);
      expect(probe.drain()).toHaveLength(0);
    }
  });

  test("stalled subscribers reach queue-full and drop, healthy one keeps draining", () => {
    const hub = new Hub();
    const res = runPublisherLatencyBenchmark({
      k: 2,
      warmup: 400, // > 256-message cap → stalled subs are at queue-full
      measure: 100,
      hub,
      callId: "bench-call",
    });
    expect(res.count).toBe(100);
    // The hub recorded drops on the stalled subscribers' channel.
    expect(hub.wsDroppedTotal("bench-call")).toBeGreaterThan(0);
  });
});

describe("runBenchOrSkip — skip-loudly gate (§6.2 #3 / §10 #12)", () => {
  test("with the isolation label ABSENT it skips loudly and does NOT assert", () => {
    const warnings: string[] = [];
    const out = runBenchOrSkip(
      {},
      { warning: (m) => warnings.push(m), notice: () => {} },
    );
    expect(out.skipped).toBe(true);
    expect(out.ok).toBe(true); // non-asserting: a skip is never a failure
    expect(out.results).toHaveLength(0); // proves no benchmark ran / asserted
    expect(warnings.join("\n")).toContain("::warning");
    expect(warnings.join("\n")).toContain(ISOLATED_LABEL);
  });

  test("with a non-matching label it still skips loudly", () => {
    const warnings: string[] = [];
    const out = runBenchOrSkip(
      { BENCH_RUNNER_LABEL: "some-shared-runner" },
      { warning: (m) => warnings.push(m), notice: () => {} },
    );
    expect(out.skipped).toBe(true);
    expect(out.ok).toBe(true);
    expect(warnings.join("\n")).toContain("::warning");
  });

  test("with the isolation label PRESENT it runs and asserts the SLO", () => {
    const notices: string[] = [];
    const lat: number[] = [];
    for (let i = 0; i < 60; i++) lat.push(1000); // all ~1 ms → PASS
    const out = runBenchOrSkip(
      { BENCH_RUNNER_LABEL: ISOLATED_LABEL },
      { warning: () => {}, notice: (m) => notices.push(m) },
      { ks: [1], warmup: 100, measure: 60, clock: scriptedClock(lat), rng: mulberry32(3), resamples: 200 },
    );
    expect(out.skipped).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.results).toHaveLength(1);
    expect((out.results[0] as BenchResult).pass).toBe(true);
    expect(notices.join("\n")).toContain("samograph-bench-isolated");
  });

  test("present label + a breaching tail → ok=false (the SLO actually asserts)", () => {
    const lat: number[] = [];
    for (let i = 0; i < 100; i++) lat.push(i < 80 ? 1000 : 9000);
    const out = runBenchOrSkip(
      { BENCH_RUNNER_LABEL: ISOLATED_LABEL },
      { warning: () => {}, notice: () => {} },
      { ks: [1], warmup: 100, measure: 100, clock: scriptedClock(lat), rng: mulberry32(3), resamples: 200 },
    );
    expect(out.skipped).toBe(false);
    expect(out.ok).toBe(false);
  });
});
