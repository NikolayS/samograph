/**
 * A compact HDR (High Dynamic Range) histogram — the recorder the §6.2 #3
 * publisher-latency benchmark uses (SPEC §6.2 #3: "latencies recorded into an
 * HDR histogram, p99 reported with a 95 % bootstrap confidence interval").
 *
 * It is a faithful, self-contained port of the canonical HdrHistogram bucketing
 * (lowest discernible value = 1, configurable significant digits): values are
 * stored in log-linear buckets giving a BOUNDED relative error (≈ 10^-sigDigits)
 * with O(1) record and percentile queries and no per-sample allocation. We keep
 * only the in-repo, dependency-free core needed for the benchmark; raw samples
 * for the bootstrap CI are collected separately by the harness.
 */
export interface HdrOptions {
  /** Highest value the histogram can track without saturating (default 1e9 µs ≈ 1000 s). */
  highestTrackableValue?: number;
  /** Significant value digits → relative precision (default 3 ⇒ ~0.1 %). */
  significantDigits?: number;
}

export class HdrHistogram {
  private readonly subBucketHalfCountMagnitude: number;
  private readonly subBucketCount: number;
  private readonly subBucketHalfCount: number;
  private readonly subBucketMask: number;
  private readonly leadingZeroCountBase: number;
  private readonly counts: Int32Array;

  totalCount = 0;
  /** Smallest recorded value (0 if none). */
  min = 0;
  /** Largest recorded value (0 if none). */
  max = 0;

  constructor(opts: HdrOptions = {}) {
    const sig = opts.significantDigits ?? 3;
    const highest = opts.highestTrackableValue ?? 1_000_000_000;

    const largestValueWithSingleUnitResolution = 2 * Math.pow(10, sig);
    const subBucketCountMagnitude = Math.ceil(
      Math.log2(largestValueWithSingleUnitResolution),
    );
    this.subBucketHalfCountMagnitude =
      (subBucketCountMagnitude < 1 ? 1 : subBucketCountMagnitude) - 1;
    this.subBucketCount = Math.pow(2, this.subBucketHalfCountMagnitude + 1);
    this.subBucketHalfCount = this.subBucketCount / 2;
    this.subBucketMask = this.subBucketCount - 1; // unitMagnitude = 0

    // leadingZeroCountBase for 32-bit clz (unitMagnitude = 0).
    this.leadingZeroCountBase = 32 - (this.subBucketHalfCountMagnitude + 1);

    // Number of buckets needed to reach `highest`.
    let smallestUntrackable = this.subBucketCount;
    let bucketsNeeded = 1;
    while (smallestUntrackable < highest) {
      smallestUntrackable *= 2;
      bucketsNeeded++;
    }
    const countsLen = (bucketsNeeded + 1) * this.subBucketHalfCount;
    this.counts = new Int32Array(countsLen);
  }

  private bucketIndexOf(value: number): number {
    return this.leadingZeroCountBase - Math.clz32(value | this.subBucketMask);
  }

  private subBucketIndexOf(value: number, bucketIndex: number): number {
    return Math.floor(value / Math.pow(2, bucketIndex));
  }

  private countsIndex(bucketIndex: number, subBucketIndex: number): number {
    const bucketBaseIndex = (bucketIndex + 1) << this.subBucketHalfCountMagnitude;
    const offsetInBucket = subBucketIndex - this.subBucketHalfCount;
    return bucketBaseIndex + offsetInBucket;
  }

  private countsIndexFor(value: number): number {
    const bucketIndex = this.bucketIndexOf(value);
    const subBucketIndex = this.subBucketIndexOf(value, bucketIndex);
    return this.countsIndex(bucketIndex, subBucketIndex);
  }

  /** Lowest value represented by a counts-array index (its bucket's floor). */
  private valueAtIndex(index: number): number {
    let bucketIndex = (index >> this.subBucketHalfCountMagnitude) - 1;
    let subBucketIndex = (index & (this.subBucketHalfCount - 1)) + this.subBucketHalfCount;
    if (bucketIndex < 0) {
      subBucketIndex -= this.subBucketHalfCount;
      bucketIndex = 0;
    }
    return subBucketIndex * Math.pow(2, bucketIndex);
  }

  /** Record one value (clamped to the trackable range). */
  record(value: number): void {
    const v = value < 0 ? 0 : value;
    const idx = this.countsIndexFor(v);
    const clamped = idx >= this.counts.length ? this.counts.length - 1 : idx;
    this.counts[clamped]!++;
    if (this.totalCount === 0) {
      this.min = v;
      this.max = v;
    } else {
      if (v < this.min) this.min = v;
      if (v > this.max) this.max = v;
    }
    this.totalCount++;
  }

  /**
   * Value at the given percentile (0–100), nearest-rank: the smallest recorded
   * bucket whose cumulative count reaches `ceil(p/100 · totalCount)`. Returns 0
   * for an empty histogram.
   */
  valueAtPercentile(percentile: number): number {
    if (this.totalCount === 0) return 0;
    const p = Math.min(100, Math.max(0, percentile));
    const target = Math.max(1, Math.ceil((p / 100) * this.totalCount));
    let running = 0;
    for (let i = 0; i < this.counts.length; i++) {
      running += this.counts[i]!;
      if (running >= target) return this.valueAtIndex(i);
    }
    return this.max;
  }
}
