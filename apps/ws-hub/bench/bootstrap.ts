/**
 * Seeded bootstrap confidence interval for a percentile (SPEC §6.2 #3).
 *
 * The publisher-latency SLO is asserted on the UPPER bound of a 95 % bootstrap
 * confidence interval of the p99 — not the point estimate — so the assertion is
 * statistically honest under sampling noise. The PRNG is seeded so the whole
 * computation is DETERMINISTIC: the benchmark must never flake (§10 #12).
 */

/** Deterministic mulberry32 PRNG → uniform [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentileOfSorted(sorted: ArrayLike<number>, percentile: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = Math.min(n - 1, Math.max(0, Math.ceil((percentile / 100) * n) - 1));
  return sorted[rank]!;
}

export interface BootstrapOptions {
  /** Percentile to estimate (default 99). */
  percentile?: number;
  /** Bootstrap resample count (default 1000). */
  resamples?: number;
  /** Two-sided confidence level (default 0.95). */
  ciLevel?: number;
  /** Seeded uniform [0,1) source (default `mulberry32(0xC0FFEE)`). */
  rng?: () => number;
}

export interface PercentileCI {
  /** Point estimate of the percentile over the original sample. */
  point: number;
  /** Lower bound of the bootstrap CI. */
  lower: number;
  /** Upper bound of the bootstrap CI (the SLO is asserted against this). */
  upper: number;
}

/**
 * Compute a bootstrap confidence interval for the given percentile. Resamples
 * the data with replacement `resamples` times, takes the percentile of each
 * resample, and returns the empirical CI bounds at `ciLevel`.
 */
export function bootstrapPercentileCI(
  samples: readonly number[],
  opts: BootstrapOptions = {},
): PercentileCI {
  const percentile = opts.percentile ?? 99;
  const resamples = opts.resamples ?? 1000;
  const ciLevel = opts.ciLevel ?? 0.95;
  const rng = opts.rng ?? mulberry32(0xc0ffee);

  const n = samples.length;
  if (n === 0) return { point: 0, lower: 0, upper: 0 };

  const original = [...samples].sort((a, b) => a - b);
  const point = percentileOfSorted(original, percentile);

  const dist = new Float64Array(resamples);
  const resample = new Float64Array(n);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) {
      resample[i] = samples[Math.floor(rng() * n)]!;
    }
    resample.sort();
    dist[b] = percentileOfSorted(resample, percentile);
  }
  dist.sort();

  const alpha = (1 - ciLevel) / 2;
  const lower = percentileOfSorted(dist, alpha * 100);
  const upper = percentileOfSorted(dist, (1 - alpha) * 100);
  return { point, lower, upper };
}
