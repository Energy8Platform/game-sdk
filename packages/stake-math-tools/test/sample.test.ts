// test/sample.test.ts
import { describe, expect, it } from 'vitest';
import { mulberry32, weightedReservoirSample, computeQuotas, stratifiedSample } from '../src/sample.js';
import type { Bucket } from '../src/bucketize.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(0xC0FFEE);
    const b = mulberry32(0xC0FFEE);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });
  it('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe('weightedReservoirSample (A-Res)', () => {
  it('samples k items, biased toward higher weights, deterministically per seed', () => {
    // 5 candidates, weights heavily skewed toward index 4
    const weights = [1, 1, 1, 1, 1_000_000];
    const k = 1;
    const rng = mulberry32(42);
    const sampled = weightedReservoirSample([0, 1, 2, 3, 4], weights, k, rng);
    expect(sampled).toEqual([4]);
  });

  it('returns all items if k >= n (no replacement)', () => {
    const rng = mulberry32(1);
    const sampled = weightedReservoirSample([0, 1, 2], [1, 1, 1], 5, rng);
    expect(sampled.sort()).toEqual([0, 1, 2]);
  });

  it('produces stable output for a given seed (snapshot)', () => {
    const rng = mulberry32(0xC0FFEE);
    const sampled = weightedReservoirSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
                                             [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, rng);
    // Snapshot: any change in mulberry32 or A-Res will surface here.
    expect(sampled.sort()).toMatchSnapshot();
  });
});

describe('computeQuotas', () => {
  it('honors minPerBucket on non-empty non-zero buckets', () => {
    const zero: Bucket = { indices: Array(100).fill(0), totalWeight: 100, weightedPayoutSum: 0 };
    const log: Bucket[] = [
      { indices: [0, 1, 2], totalWeight: 3, weightedPayoutSum: 30 },
      { indices: [3, 4, 5, 6, 7], totalWeight: 5, weightedPayoutSum: 200 },
      { indices: [], totalWeight: 0, weightedPayoutSum: 0 },
    ];
    const nearMax: Bucket = { indices: [7], totalWeight: 1, weightedPayoutSum: 100 };

    const quotas = computeQuotas({
      zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax,
    }, { nRowsOut: 20, minPerBucket: 3, requireMaxReached: true });

    expect(quotas.logBuckets[0]).toBeGreaterThanOrEqual(3);
    expect(quotas.logBuckets[1]).toBeGreaterThanOrEqual(3);
    expect(quotas.logBuckets[2]).toBe(0); // empty bucket, zero quota
    expect(quotas.nearMaxBucket).toBeGreaterThanOrEqual(1);
    const total = quotas.zeroBucket + quotas.logBuckets.reduce((a,b) => a+b, 0) + quotas.nearMaxBucket;
    expect(total).toBe(20);
  });

  it('caps a quota at the bucket size (cannot ask for more rows than the bucket has)', () => {
    const zero: Bucket = { indices: [0], totalWeight: 1, weightedPayoutSum: 0 };
    const log: Bucket[] = [
      { indices: [1, 2], totalWeight: 2, weightedPayoutSum: 200 }, // only 2 rows here
    ];
    const nearMax: Bucket = { indices: [], totalWeight: 0, weightedPayoutSum: 0 };
    const quotas = computeQuotas({ zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax },
      { nRowsOut: 10, minPerBucket: 5, requireMaxReached: true });
    expect(quotas.logBuckets[0]).toBeLessThanOrEqual(2);
    expect(quotas.zeroBucket).toBeLessThanOrEqual(1);
  });
});

describe('computeQuotas (over-allocation guard)', () => {
  it('caps total quota at nRowsOut even when min allocation would overshoot', () => {
    // 10 non-empty log buckets, minPerBucket=3, nRowsOut=20 → 30 > 20
    const log: Bucket[] = Array.from({ length: 10 }, (_, i) => ({
      indices: [i * 10, i * 10 + 1, i * 10 + 2],
      totalWeight: 3,
      weightedPayoutSum: 100 * (i + 1),
    }));
    const zero: Bucket = { indices: [], totalWeight: 0, weightedPayoutSum: 0 };
    const nearMax: Bucket = { indices: [], totalWeight: 0, weightedPayoutSum: 0 };
    const quotas = computeQuotas(
      { zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax },
      { nRowsOut: 20, minPerBucket: 3, requireMaxReached: false },
    );
    const total = quotas.zeroBucket + quotas.logBuckets.reduce((a, b) => a + b, 0) + quotas.nearMaxBucket;
    expect(total).toBe(20);
    expect(quotas.zeroBucket).toBeGreaterThanOrEqual(0);
    for (const q of quotas.logBuckets) expect(q).toBeGreaterThanOrEqual(0);
  });
});

describe('computeQuotas — targetHitRate bias', () => {
  it('allocates zero/nonzero quotas proportional to targetHitRate', () => {
    const zero: Bucket = {
      indices: Array.from({ length: 5000 }, (_, i) => i),
      totalWeight: 5000,
      weightedPayoutSum: 0,
    };
    const log: Bucket[] = Array.from({ length: 5 }, (_, k) => ({
      indices: Array.from({ length: 200 }, (_, j) => 5000 + k * 200 + j),
      totalWeight: 200,
      weightedPayoutSum: 200 * (10 ** (k + 1)),
    }));
    const nearMax: Bucket = { indices: [5999], totalWeight: 1, weightedPayoutSum: 1000 };
    const quotas = computeQuotas(
      { zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax },
      { nRowsOut: 1000, minPerBucket: 3, requireMaxReached: false, targetHitRate: 0.2 },
    );
    // Expect ~800 zero and ~200 non-zero (including across log buckets)
    expect(quotas.zeroBucket).toBeGreaterThanOrEqual(750);
    expect(quotas.zeroBucket).toBeLessThanOrEqual(850);
    const totalNonZero = quotas.logBuckets.reduce((s, q) => s + q, 0) + quotas.nearMaxBucket;
    expect(totalNonZero).toBeGreaterThanOrEqual(150);
    expect(totalNonZero).toBeLessThanOrEqual(250);
    const total = quotas.zeroBucket + totalNonZero;
    expect(total).toBe(1000);
  });

  it('falls back to variance-contribution behavior when targetHitRate is unset', () => {
    // Same buckets as the very first computeQuotas test in this file — invariant
    // must be preserved (zero bucket absorbs leftover; total === nRowsOut).
    const zero: Bucket = { indices: Array(100).fill(0).map((_, i) => i), totalWeight: 100, weightedPayoutSum: 0 };
    const log: Bucket[] = [
      { indices: [100, 101, 102], totalWeight: 3, weightedPayoutSum: 30 },
      { indices: [103, 104, 105, 106, 107], totalWeight: 5, weightedPayoutSum: 200 },
      { indices: [], totalWeight: 0, weightedPayoutSum: 0 },
    ];
    const nearMax: Bucket = { indices: [107], totalWeight: 1, weightedPayoutSum: 100 };
    const quotas = computeQuotas(
      { zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax },
      { nRowsOut: 20, minPerBucket: 3, requireMaxReached: true /* no targetHitRate */ },
    );
    // Pre-fix invariants — same as the original test
    expect(quotas.logBuckets[0]).toBeGreaterThanOrEqual(3);
    expect(quotas.logBuckets[1]).toBeGreaterThanOrEqual(3);
    expect(quotas.logBuckets[2]).toBe(0);
    expect(quotas.nearMaxBucket).toBeGreaterThanOrEqual(1);
    const total = quotas.zeroBucket + quotas.logBuckets.reduce((a, b) => a + b, 0) + quotas.nearMaxBucket;
    expect(total).toBe(20);
  });

  it('handles targetHitRate=0.5 on a balanced distribution', () => {
    const zero: Bucket = {
      indices: Array.from({ length: 1000 }, (_, i) => i),
      totalWeight: 1000,
      weightedPayoutSum: 0,
    };
    const log: Bucket[] = Array.from({ length: 5 }, (_, k) => ({
      indices: Array.from({ length: 200 }, (_, j) => 1000 + k * 200 + j),
      totalWeight: 200,
      weightedPayoutSum: 200 * (10 ** (k + 1)),
    }));
    const nearMax: Bucket = { indices: [1999], totalWeight: 1, weightedPayoutSum: 1000 };
    const quotas = computeQuotas(
      { zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax },
      { nRowsOut: 500, minPerBucket: 3, requireMaxReached: false, targetHitRate: 0.5 },
    );
    expect(quotas.zeroBucket).toBeGreaterThanOrEqual(225);
    expect(quotas.zeroBucket).toBeLessThanOrEqual(275);
    const totalNonZero = quotas.logBuckets.reduce((s, q) => s + q, 0) + quotas.nearMaxBucket;
    expect(totalNonZero).toBeGreaterThanOrEqual(225);
    expect(totalNonZero).toBeLessThanOrEqual(275);
    const total = quotas.zeroBucket + totalNonZero;
    expect(total).toBe(500);
  });
});

describe('stratifiedSample (overlap top-up)', () => {
  it('delivers exactly the total quota even when near-max overlaps log buckets', () => {
    // Top log bucket overlaps near-max bucket; near-max consumes enough that the
    // log bucket cannot fulfil its quota from its own indices alone.
    const rows = Array.from({ length: 20 }, () => ({ weight: 1 }));
    const zero: Bucket = { indices: [0, 1, 2, 3, 4, 5], totalWeight: 6, weightedPayoutSum: 0 };
    const log: Bucket[] = [
      { indices: [10, 11, 12, 13, 14], totalWeight: 5, weightedPayoutSum: 1000 },
    ];
    const nearMax: Bucket = { indices: [10, 11, 12, 13, 14], totalWeight: 5, weightedPayoutSum: 1000 };
    // Near-max takes 3, log wants 3 — only 2 will be available after overlap → shortfall of 1.
    const quotas = { zeroBucket: 3, logBuckets: [3], nearMaxBucket: 3 }; // total 9
    const rng = mulberry32(1);
    const sampled = stratifiedSample(
      { zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax },
      rows,
      quotas,
      rng,
    );
    expect(sampled.length).toBe(9);
  });
});
