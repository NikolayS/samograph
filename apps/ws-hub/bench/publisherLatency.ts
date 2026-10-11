/**
 * WS publisher-latency SLO benchmark over the merged hub CORE (SPEC §5.5, §6.2
 * #3, §10 #12).
 *
 * Methodology (verbatim from §6.2 #3): a dedicated CI runner with single-tenant
 * isolation (one benchmark per job, no co-tenant load), ONE healthy subscriber +
 * k STALLED subscribers (never drained, so they sit at queue-full) in the SAME
 * `call_id` channel, a 1000-message warmup, a 10 000-message measurement window,
 * publisher-side per-message latency recorded into an HDR histogram, p99 reported
 * with a 95 % bootstrap confidence interval. The SLO PASSES iff the UPPER bound
 * of that CI is ≤ 5 ms. k ∈ {1, 4, 16, 32}.
 *
 * The measured operation is exactly `hub.publish(callId, frame)` — the seam
 * ingest calls — under k stalled subscribers, so each publish does the full
 * drop-oldest + gap-fold work on every stalled queue (the realistic worst case,
 * §5.5). The healthy subscriber drains between measurements to model a fast
 * client that never stalls and to prove a stalled peer never blocks it.
 *
 * On a shared CI runner (the isolation label absent) the harness SKIPS LOUDLY
 * (`::warning`, non-asserting) rather than producing a flaky number (§10 #12).
 */
import { Hub } from "../hub.ts";
import { HdrHistogram } from "./hdr.ts";
import { bootstrapPercentileCI, mulberry32 } from "./bootstrap.ts";

/** Publisher-side per-message latency SLO (§5.5 / §6.2 #3). */
export const PUBLISHER_LATENCY_SLO_MS = 5;
/** The CI runner label that guarantees single-tenant isolation (§6.2 #3 / §10 #12). */
export const ISOLATED_LABEL = "samograph-bench-isolated";
/** Stalled-subscriber counts the SLO is asserted across (§5.5). */
export const DEFAULT_KS = [1, 4, 16, 32] as const;

/** Wall-clock microsecond timestamp (high-resolution). */
const wallClockUs = (): number => Math.round(performance.now() * 1000);

export interface BenchOptions {
  /** Number of STALLED subscribers at queue-full in the channel. */
  k: number;
  /** Warmup publishes (not measured); default 1000 (§6.2 #3). */
  warmup?: number;
  /** Measured publishes; default 10 000 (§6.2 #3). */
  measure?: number;
  /** Hub under test; default a fresh in-process {@link Hub}. */
  hub?: Hub;
  /** Channel id; default `bench-call`. */
  callId?: string;
  /** Microsecond clock, called before+after each measured publish; default wall clock. */
  clock?: () => number;
  /** Seeded PRNG for the bootstrap; default `mulberry32(0xBE17)`. */
  rng?: () => number;
  /** Bootstrap resample count; default 1000. */
  resamples?: number;
}

export interface BenchResult {
  k: number;
  /** Number of measured publishes. */
  count: number;
  /** p99 (ms) from the HDR histogram. */
  p99Ms: number;
  /** Lower bound of the 95 % bootstrap CI of the p99 (ms). */
  ciLowerMs: number;
  /** Upper bound of the 95 % bootstrap CI of the p99 (ms) — the SLO is asserted here. */
  ciUpperMs: number;
  /** PASS iff `ciUpperMs ≤ PUBLISHER_LATENCY_SLO_MS`. */
  pass: boolean;
}

/**
 * Run the publisher-latency benchmark for a single `k`. Pure aside from the
 * injectable clock/PRNG — deterministic when both are supplied (tests do).
 */
export function runPublisherLatencyBenchmark(opts: BenchOptions): BenchResult {
  const warmup = opts.warmup ?? 1000;
  const measure = opts.measure ?? 10_000;
  const hub = opts.hub ?? new Hub();
  const callId = opts.callId ?? "bench-call";
  const clock = opts.clock ?? wallClockUs;
  const rng = opts.rng ?? mulberry32(0xbe17);
  const resamples = opts.resamples ?? 1000;

  const healthy = hub.subscribe(callId);
  for (let i = 0; i < opts.k; i++) hub.subscribe(callId); // k stalled, never drained

  let seq = 0;
  // Warmup: fill the stalled queues to their cap so the measured window is the
  // steady-state drop-oldest worst case. The healthy subscriber drains to stay fast.
  for (let i = 0; i < warmup; i++) {
    hub.publish(callId, { seq: seq++ });
    healthy.drain();
  }

  const hdr = new HdrHistogram();
  const samples = new Array<number>(measure);
  for (let i = 0; i < measure; i++) {
    const t0 = clock();
    hub.publish(callId, { seq: seq++ });
    const t1 = clock();
    const latUs = t1 - t0 < 0 ? 0 : t1 - t0;
    hdr.record(latUs);
    samples[i] = latUs;
    healthy.drain(); // fast client; never blocks despite k stalled peers
  }

  const ci = bootstrapPercentileCI(samples, { percentile: 99, resamples, rng });
  const ciUpperMs = ci.upper / 1000;
  return {
    k: opts.k,
    count: measure,
    p99Ms: hdr.valueAtPercentile(99) / 1000,
    ciLowerMs: ci.lower / 1000,
    ciUpperMs,
    pass: ciUpperMs <= PUBLISHER_LATENCY_SLO_MS,
  };
}

export interface BenchEnv {
  BENCH_RUNNER_LABEL?: string;
}

/** Sink for the GitHub-annotation lines the harness emits. */
export interface BenchLog {
  warning(line: string): void;
  notice(line: string): void;
}

export interface RunBenchOptions {
  /** k values to assert (default {@link DEFAULT_KS}). */
  ks?: number[];
  warmup?: number;
  measure?: number;
  clock?: () => number;
  rng?: () => number;
  resamples?: number;
}

export interface RunBenchOutcome {
  /** True when the isolated runner is absent and the SLO was not asserted. */
  skipped: boolean;
  /** True when skipped, or when every measured k passed. */
  ok: boolean;
  /** Per-k results (empty when skipped). */
  results: BenchResult[];
}

/**
 * Gate the benchmark on the single-tenant isolated runner. Off that runner it
 * SKIPS LOUDLY (a `::warning` annotation) and returns `ok: true` WITHOUT running
 * or asserting anything — preventing silent flake on shared CI (§6.2 #3 / §10
 * #12). On the isolated runner it runs k ∈ {1,4,16,32} and asserts the SLO.
 */
export function runBenchOrSkip(
  env: BenchEnv,
  log: BenchLog,
  opts: RunBenchOptions = {},
): RunBenchOutcome {
  const label = env.BENCH_RUNNER_LABEL ?? "";
  if (label !== ISOLATED_LABEL) {
    log.warning(
      `::warning title=benchmark-runner SKIPPED::No single-tenant isolated runner ` +
        `(label '${ISOLATED_LABEL}' absent). Per SPEC §6.2 #3 / §10 #12 the WS ` +
        `publisher-latency p99<=${PUBLISHER_LATENCY_SLO_MS}ms SLO is SKIPPED LOUDLY ` +
        `on shared CI rather than asserted, to prevent silent flake. Register the ` +
        `isolated runner and set repo variable BENCH_RUNNER_LABEL=${ISOLATED_LABEL} to enable.`,
    );
    return { skipped: true, ok: true, results: [] };
  }

  const ks = opts.ks ?? [...DEFAULT_KS];
  log.notice(
    `::notice title=benchmark-runner::Dedicated single-tenant runner ` +
      `'${ISOLATED_LABEL}' present — asserting WS publisher-latency ` +
      `p99<=${PUBLISHER_LATENCY_SLO_MS}ms SLO (SPEC §6.2 #3) for k ∈ {${ks.join(", ")}}.`,
  );

  const results: BenchResult[] = [];
  let ok = true;
  for (const k of ks) {
    const res = runPublisherLatencyBenchmark({
      k,
      warmup: opts.warmup,
      measure: opts.measure,
      clock: opts.clock,
      rng: opts.rng,
      resamples: opts.resamples,
    });
    results.push(res);
    if (!res.pass) ok = false;
    log.notice(
      `::notice title=benchmark-runner::k=${k} p99=${res.p99Ms.toFixed(3)}ms ` +
        `ci95=[${res.ciLowerMs.toFixed(3)}, ${res.ciUpperMs.toFixed(3)}]ms -> ` +
        `${res.pass ? "PASS" : "FAIL"}`,
    );
  }
  return { skipped: false, ok, results };
}
