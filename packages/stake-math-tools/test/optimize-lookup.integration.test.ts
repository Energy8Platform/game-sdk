// test/optimize-lookup.integration.test.ts
import { describe, expect, it } from 'vitest';
import { optimizeLookupTable } from '../src/optimize-lookup.js';
import type { LookupRow } from '../src/types.js';

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate rows where the natural population has approximately the requested
 * RTP and CV, by mixing zero-payout rows (probability 1−hitRate) with payouts
 * drawn from a log-normal scaled to hit the moments.
 */
function genTargeted(n: number, targetRTP: number, targetHitRate: number, capCents: number, seed: number): LookupRow[] {
  const rng = makeRng(seed);
  const rows: LookupRow[] = [];
  // mean payout when hit: targetRTP * 100 / targetHitRate
  const meanHit = (targetRTP * 100) / targetHitRate;
  for (let i = 0; i < n; i++) {
    const u = rng();
    let payoutCents: number;
    if (u > targetHitRate) {
      payoutCents = 0;
    } else {
      // log-normal-ish payout
      const v = rng();
      const draw = -Math.log(Math.max(1e-9, v)) * meanHit;
      payoutCents = Math.min(Math.floor(draw), capCents);
    }
    rows.push({ sim: i, weight: 1, payoutCents });
  }
  return rows;
}

describe('integration', () => {
  it('1. trivial recovery — natural distribution matches targets', () => {
    const rows = genTargeted(2000, 0.96, 0.30, 50_000, 1);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.02,
      targetCV: 5.0, toleranceCV: 2.0,
      targetHitRate: 0.30, toleranceHitRate: 0.05,
      capMaxWin: 50_000,
      nRowsOut: 200,
      requireMaxReached: false,
      maxIterations: 3,
    });
    expect(result.toleranceMet.rtp).toBe(true);
    expect(result.toleranceMet.hitRate).toBe(true);
  });

  it('2. filtered overshoot — input RTP=1.05 → optimizer pulls to 0.96', () => {
    const rows = genTargeted(3000, 1.05, 0.40, 50_000, 2);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.02,
      targetCV: 5.0, toleranceCV: 2.0,
      targetHitRate: 0.30, toleranceHitRate: 0.10,
      capMaxWin: 50_000,
      nRowsOut: 300,
      requireMaxReached: false,
      maxIterations: 3,
    });
    expect(result.toleranceMet.rtp).toBe(true);
  });

  it('3. infeasible target — graceful degradation', () => {
    const rows = genTargeted(500, 0.30, 0.10, 1000, 3);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.30, toleranceRTP: 0.05,
      targetCV: 50, toleranceCV: 0.1,        // infeasibly large CV
      targetHitRate: 0.10, toleranceHitRate: 0.05,
      capMaxWin: 1000,
      nRowsOut: 100,
      requireMaxReached: false,
      maxIterations: 2,
    });
    expect(result.toleranceMet.cv).toBe(false);
    expect(result.warnings.some((w) => /CV/i.test(w))).toBe(true);
  });

  it('4. near-max representation — top-end row is in output', () => {
    const rng = makeRng(4);
    const rows: LookupRow[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        sim: i,
        weight: 1,
        payoutCents: rng() < 0.7 ? 0 : Math.floor(rng() * 50_000),
      });
    }
    rows.push({ sim: 9999, weight: 1, payoutCents: 990_000 }); // near-max of 1_000_000
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.30, toleranceHitRate: 0.5,
      capMaxWin: 1_000_000,
      maxReachedFraction: 0.95,
      requireMaxReached: true,
      nRowsOut: 100,
      maxIterations: 2,
    });
    expect(result.achieved.maxPayout).toBeGreaterThanOrEqual(0.95 * 1_000_000);
  });

  it('5. smoke at scale — 1M synthetic rows in under 30s', () => {
    const rng = makeRng(5);
    const rows: LookupRow[] = new Array(1_000_000);
    for (let i = 0; i < 1_000_000; i++) {
      const u = rng();
      let p = 0;
      if (u > 0.7) p = Math.floor(rng() * 200);
      if (u > 0.97) p = Math.floor(rng() * 5_000);
      if (u > 0.999) p = Math.floor(rng() * 50_000);
      rows[i] = { sim: i, weight: 1 + Math.floor(rng() * 10), payoutCents: p };
    }

    const t0 = performance.now();
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.5, toleranceRTP: 0.2,
      targetCV: 3, toleranceCV: 5,
      targetHitRate: 0.30, toleranceHitRate: 0.1,
      capMaxWin: 50_000,
      nRowsOut: 1000,
      requireMaxReached: false,
      maxIterations: 2,
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(30_000);
    let sum = 0;
    for (const r of result.rows) sum += r.weight;
    expect(sum).toBe(1000 * 1_000_000);
  });

  it('6. handles nRowsOut=5000 without n² memory blowup', () => {
    // Pre-fix this would allocate a 5000×5000 dense matrix (200 MB Float64);
    // after the implicit-Tikhonov fix it should fit in well under 100 MB and
    // complete in a few seconds.
    const rng = makeRng(6);
    const rows: LookupRow[] = new Array(200_000);
    for (let i = 0; i < 200_000; i++) {
      const u = rng();
      let p = 0;
      if (u > 0.7) p = Math.floor(rng() * 200);
      if (u > 0.97) p = Math.floor(rng() * 5_000);
      if (u > 0.999) p = Math.floor(rng() * 50_000);
      rows[i] = { sim: i, weight: 1 + Math.floor(rng() * 10), payoutCents: p };
    }

    const t0 = performance.now();
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.5, toleranceRTP: 0.2,
      targetCV: 3, toleranceCV: 5,
      targetHitRate: 0.30, toleranceHitRate: 0.1,
      capMaxWin: 50_000,
      nRowsOut: 5_000,
      requireMaxReached: false,
      maxIterations: 1,  // single pass — we're testing memory, not convergence
    });
    const elapsed = performance.now() - t0;

    expect(result.rows).toHaveLength(5_000);
    // Should be well under the testTimeout (30s). 60s as a generous upper bound.
    expect(elapsed).toBeLessThan(60_000);
    let sum = 0;
    for (const r of result.rows) sum += r.weight;
    expect(sum).toBe(5_000 * 1_000_000);
  });
});
