/**
 * CI entry point for the WS publisher-latency SLO benchmark (SPEC §6.2 #3).
 *
 * Run by the dedicated `benchmark-runner` job in `.github/workflows/ci.yml`.
 * It gates on the `BENCH_RUNNER_LABEL` repo variable: on the single-tenant
 * isolated runner it asserts the p99 ≤ 5 ms SLO for k ∈ {1,4,16,32} and exits
 * non-zero on breach; everywhere else it SKIPS LOUDLY (a `::warning`
 * annotation) and exits 0, so absence of the isolated runner never red-bars the
 * build but is always visible (§10 #12).
 */
import { runBenchOrSkip, type BenchEnv } from "./publisherLatency.ts";

if (import.meta.main) {
  const log = {
    warning: (line: string) => console.log(line),
    notice: (line: string) => console.log(line),
  };
  const outcome = runBenchOrSkip(process.env as BenchEnv, log);
  if (outcome.skipped) {
    console.log("benchmark-runner: SKIPPED (no isolated runner) — not asserting.");
  } else {
    console.log(`benchmark-runner: ${outcome.ok ? "PASS" : "FAIL"} (asserted on isolated runner).`);
  }
  process.exit(outcome.ok ? 0 : 1);
}
