// test/metrics.test.ts
import { describe, expect, it } from 'vitest';
import { computeMetrics, isNearMax } from '../src/metrics.js';
import type { LookupRow } from '../src/types.js';

describe('computeMetrics', () => {
  it('returns weighted RTP, CV, hitRate, maxPayout, totalWeight on a hand-checked input', () => {
    // 4 rows, weight=1 each: payouts 0, 100, 200, 100
    // mean payout = (0 + 100 + 200 + 100) / 4 = 100
    // RTP = mean / 100 = 1.0
    // var = ((0-100)^2 + 0 + (200-100)^2 + 0) / 4 = 5000
    // stddev = sqrt(5000) ≈ 70.7106781
    // CV = stddev / mean ≈ 0.7071068
    // hitRate = 3/4 = 0.75
    const rows: LookupRow[] = [
      { sim: 1, weight: 1, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 100 },
      { sim: 3, weight: 1, payoutCents: 200 },
      { sim: 4, weight: 1, payoutCents: 100 },
    ];

    const m = computeMetrics(rows);

    expect(m.totalWeight).toBe(4);
    expect(m.rtp).toBeCloseTo(1.0, 10);
    expect(m.maxPayout).toBe(200);
    expect(m.hitRate).toBeCloseTo(0.75, 10);
    expect(m.cv).toBeCloseTo(Math.sqrt(5000) / 100, 10);
  });

  it('honors weights (non-uniform)', () => {
    // 2 rows: (w=3, p=0), (w=1, p=400) → totalW=4, mean=100, RTP=1.0, hitRate=0.25
    const rows: LookupRow[] = [
      { sim: 1, weight: 3, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 400 },
    ];
    const m = computeMetrics(rows);
    expect(m.rtp).toBeCloseTo(1.0, 10);
    expect(m.hitRate).toBeCloseTo(0.25, 10);
  });

  it('returns CV=0 and rtp=0 when all payouts are zero', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 5, payoutCents: 0 },
      { sim: 2, weight: 7, payoutCents: 0 },
    ];
    const m = computeMetrics(rows);
    expect(m.rtp).toBe(0);
    expect(m.cv).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.maxPayout).toBe(0);
  });
});

describe('isNearMax', () => {
  it('returns true when payout ≥ fraction × cap', () => {
    expect(isNearMax(950, 1000, 0.95)).toBe(true);
    expect(isNearMax(1000, 1000, 0.95)).toBe(true);
    expect(isNearMax(949, 1000, 0.95)).toBe(false);
  });
});
