// test/quantize.test.ts
import { describe, expect, it } from 'vitest';
import { quantizeWeights } from '../src/quantize.js';

describe('quantizeWeights', () => {
  it('exactly preserves the target sum (deficit > 0 case)', () => {
    // floors = [10, 20, 30, 40] → sum 100; total 103 → deficit 3
    // remainders all 0.7 → tie; first 3 indices get +1
    const out = quantizeWeights([10.7, 20.7, 30.7, 40.7], 103);
    expect(out.reduce((a, b) => a + b, 0)).toBe(103);
    expect(out).toEqual([11, 21, 31, 40]);
  });

  it('exactly preserves the target sum (deficit < 0 case)', () => {
    // floors max(1, ...) = [10, 20, 30, 40] → sum 100; total 99 → deficit -1
    // largest current weight is 40 → decrement to 39
    const out = quantizeWeights([10.7, 20.3, 30.7, 40.3], 99);
    expect(out.reduce((a, b) => a + b, 0)).toBe(99);
    expect(out).toEqual([10, 20, 30, 39]);
  });

  it('clamps each output to ≥ 1 (so output never drops a row)', () => {
    // floors = [1, 1, 1, 100] sum 103; total 103 → deficit 0
    // (raw floor of 0.1 would be 0, but max(1, …) bumps it to 1)
    const out = quantizeWeights([0.1, 0.2, 0.3, 100], 103);
    expect(out.length).toBe(4);
    for (const w of out) expect(w).toBeGreaterThanOrEqual(1);
    expect(out.reduce((a, b) => a + b, 0)).toBe(103);
  });

  it('throws when total < n (impossible to satisfy w_i ≥ 1)', () => {
    expect(() => quantizeWeights([1, 1, 1], 2)).toThrow(/total.*>= n/);
  });

  it('handles ties deterministically (lower index wins on tie)', () => {
    // weights [1.5, 2.5, 3.5], floors=[1,2,3] sum 6, total 8 → deficit 2
    // all remainders are 0.5 → indices 0 and 1 should win (lower index breaks ties)
    const out = quantizeWeights([1.5, 2.5, 3.5], 8);
    expect(out).toEqual([2, 3, 3]);
  });

  it('handles large n with many floor-1 rows efficiently (regression: was O(K·n log n))', () => {
    // Synthesize a scenario that previously took 30+ seconds:
    // ~99% of rows have continuous weight near 0 (will clamp to floor 1)
    // ~1% of rows have large weight
    const n = 100_000;
    const T = n * 1_000_000;
    const weights = new Array(n);
    for (let i = 0; i < n; i++) {
      // 99% small, 1% large
      weights[i] = i % 100 === 0 ? T / 1000 : 0.0001;
    }
    const t0 = performance.now();
    const out = quantizeWeights(weights, T);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000); // 1 second — was 30+s before fix
    expect(out.length).toBe(n);
    let sum = 0;
    for (const v of out) {
      sum += v;
      expect(v).toBeGreaterThanOrEqual(1);
    }
    expect(sum).toBe(T);
  });
});
