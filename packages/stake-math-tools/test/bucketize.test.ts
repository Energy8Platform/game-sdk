// test/bucketize.test.ts
import { describe, expect, it } from 'vitest';
import { bucketize } from '../src/bucketize.js';
import type { LookupRow } from '../src/types.js';

describe('bucketize', () => {
  it('places zero payouts in bucket 0; non-zero in log buckets; near-max in its own bucket', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 100, payoutCents: 0 },     // → bucket 0
      { sim: 2, weight: 200, payoutCents: 0 },     // → bucket 0
      { sim: 3, weight: 50, payoutCents: 10 },     // → low log bucket
      { sim: 4, weight: 30, payoutCents: 100 },    // → mid log bucket
      { sim: 5, weight: 10, payoutCents: 9_500 },  // → top log bucket AND near-max (cap=10000, frac=0.95)
      { sim: 6, weight: 5, payoutCents: 10_000 },  // → top log bucket AND near-max
    ];

    const result = bucketize(rows, {
      capMaxWin: 10_000,
      bucketCount: 4,
      maxReachedFraction: 0.95,
    });

    // 1 zero bucket + 4 log buckets + 1 near-max bucket = 6 entries
    expect(result.zeroBucket.indices).toEqual([0, 1]);
    expect(result.zeroBucket.totalWeight).toBe(300);

    // log buckets have 4 entries (some may be empty)
    expect(result.logBuckets).toHaveLength(4);

    // near-max bucket: rows whose payout >= 0.95 * 10_000 = 9_500
    expect(result.nearMaxBucket.indices.sort()).toEqual([4, 5]);
    expect(result.nearMaxBucket.totalWeight).toBe(15);

    // Sanity: every non-zero row appears in exactly one log bucket
    const seen = new Set<number>();
    for (const b of result.logBuckets) for (const i of b.indices) seen.add(i);
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });

  it('drops nothing — caller is expected to filter capMaxWin before calling (defense in depth)', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 1, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 50 },
    ];
    const result = bucketize(rows, { capMaxWin: 100, bucketCount: 3, maxReachedFraction: 0.95 });
    expect(result.zeroBucket.totalWeight).toBe(1);
    const totalLog = result.logBuckets.reduce((s, b) => s + b.totalWeight, 0);
    expect(totalLog).toBe(1);
  });

  it('handles a single non-zero payout (no log spread)', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 1, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 500 },
    ];
    const result = bucketize(rows, { capMaxWin: 1000, bucketCount: 5, maxReachedFraction: 0.95 });
    const totalLog = result.logBuckets.reduce((s, b) => s + b.totalWeight, 0);
    expect(totalLog).toBe(1);
  });
});
