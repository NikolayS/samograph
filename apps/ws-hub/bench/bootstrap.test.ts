import { describe, expect, test } from "bun:test";
import { bootstrapPercentileCI, mulberry32 } from "./bootstrap.ts";

/**
 * §6.2 #3: p99 is reported with a 95 % bootstrap confidence interval; the SLO
 * PASSES iff the UPPER bound of that CI is ≤ 5 ms. The bootstrap is seeded so
 * the result is deterministic (no silent flake, §10 #12).
 */
describe("bootstrapPercentileCI — §6.2 #3", () => {
  test("is deterministic for a fixed seed", () => {
    const samples = Array.from({ length: 500 }, (_, i) => 1000 + (i % 100));
    const a = bootstrapPercentileCI(samples, { percentile: 99, resamples: 300, rng: mulberry32(7) });
    const b = bootstrapPercentileCI(samples, { percentile: 99, resamples: 300, rng: mulberry32(7) });
    expect(a).toEqual(b);
  });

  test("lower ≤ point ≤ upper", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => 800 + (i % 400));
    const ci = bootstrapPercentileCI(samples, { percentile: 99, resamples: 400, rng: mulberry32(1) });
    expect(ci.lower).toBeLessThanOrEqual(ci.point);
    expect(ci.point).toBeLessThanOrEqual(ci.upper);
  });

  test("PASS sample (tail well under 5 ms) → CI upper ≤ 5000 µs", () => {
    // 9900 ~1 ms + 100 ~4 ms (in microseconds): the p99 CI stays under 5 ms.
    const samples: number[] = [];
    for (let i = 0; i < 9900; i++) samples.push(1000 + (i % 50));
    for (let i = 0; i < 100; i++) samples.push(4000 + (i % 50));
    const ci = bootstrapPercentileCI(samples, { percentile: 99, resamples: 500, rng: mulberry32(42) });
    expect(ci.upper).toBeLessThanOrEqual(5000);
  });

  test("FAIL sample (heavy tail over 5 ms) → CI upper > 5000 µs", () => {
    // 9000 ~1 ms + 1000 ~8 ms: the 99th percentile is firmly in the 8 ms tail.
    const samples: number[] = [];
    for (let i = 0; i < 9000; i++) samples.push(1000 + (i % 50));
    for (let i = 0; i < 1000; i++) samples.push(8000 + (i % 50));
    const ci = bootstrapPercentileCI(samples, { percentile: 99, resamples: 500, rng: mulberry32(42) });
    expect(ci.upper).toBeGreaterThan(5000);
  });

  test("mulberry32 yields a stable deterministic sequence", () => {
    const r = mulberry32(123);
    const seq = [r(), r(), r()];
    const r2 = mulberry32(123);
    expect([r2(), r2(), r2()]).toEqual(seq);
    for (const x of seq) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
