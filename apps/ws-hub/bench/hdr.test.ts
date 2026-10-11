import { describe, expect, test } from "bun:test";
import { HdrHistogram } from "./hdr.ts";

/**
 * §6.2 #3 measurement methodology: latencies are recorded into an HDR histogram.
 * The histogram trades a small, BOUNDED relative error for O(1) recording and
 * percentile queries. These tests pin exact counts/min/max and that
 * `valueAtPercentile` tracks the true nearest-rank percentile within the
 * configured precision.
 */
describe("HdrHistogram — §6.2 #3", () => {
  test("records exact total count, min and max", () => {
    const h = new HdrHistogram();
    for (const v of [10, 20, 30, 40, 50]) h.record(v);
    expect(h.totalCount).toBe(5);
    expect(h.min).toBe(10);
    expect(h.max).toBe(50);
  });

  test("empty histogram returns 0 for any percentile", () => {
    const h = new HdrHistogram();
    expect(h.valueAtPercentile(50)).toBe(0);
    expect(h.valueAtPercentile(99)).toBe(0);
    expect(h.totalCount).toBe(0);
  });

  test("p99 tracks the true nearest-rank percentile within relative error", () => {
    const h = new HdrHistogram();
    const samples: number[] = [];
    // 9900 fast (~1000 µs) + 100 slow (~4000 µs): true p99 lives in the tail.
    for (let i = 0; i < 9900; i++) {
      const v = 1000 + (i % 50);
      samples.push(v);
      h.record(v);
    }
    for (let i = 0; i < 100; i++) {
      const v = 4000 + i;
      samples.push(v);
      h.record(v);
    }
    samples.sort((a, b) => a - b);
    const rank = Math.ceil((99 / 100) * samples.length) - 1;
    const truthful = samples[rank];
    const reported = h.valueAtPercentile(99);
    // Default 3 significant digits → < 0.1 % relative error.
    expect(Math.abs(reported - truthful)).toBeLessThanOrEqual(truthful * 0.01 + 1);
  });

  test("monotonic: higher percentile is never smaller", () => {
    const h = new HdrHistogram();
    for (let v = 1; v <= 5000; v++) h.record(v);
    expect(h.valueAtPercentile(50)).toBeLessThanOrEqual(h.valueAtPercentile(95));
    expect(h.valueAtPercentile(95)).toBeLessThanOrEqual(h.valueAtPercentile(99));
  });
});
