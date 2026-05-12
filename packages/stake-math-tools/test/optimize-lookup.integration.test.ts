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

  it('7. row composition reflects targetHitRate (not just weighted hit-rate)', () => {
    // Source distribution has hit-rate ≈ 0.30 (rng-controlled).
    const rng = makeRng(7);
    const rows: LookupRow[] = new Array(50_000);
    for (let i = 0; i < 50_000; i++) {
      const u = rng();
      let p = 0;
      if (u > 0.7) p = Math.floor(rng() * 200);
      if (u > 0.97) p = Math.floor(rng() * 5_000);
      if (u > 0.999) p = Math.floor(rng() * 50_000);
      rows[i] = { sim: i, weight: 1 + Math.floor(rng() * 100), payoutCents: p };
    }

    // Target hit-rate well below source (0.20 vs 0.30)
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.01,
      targetCV: 5.0, toleranceCV: 2.0,
      targetHitRate: 0.20, toleranceHitRate: 0.02,
      capMaxWin: 50_000,
      nRowsOut: 1000,
      requireMaxReached: false,
      maxIterations: 3,
    });

    // Weighted hit-rate hits target.
    expect(result.toleranceMet.hitRate).toBe(true);

    // ROW composition is roughly 80% zero, 20% non-zero.
    let nZero = 0;
    for (const r of result.rows) if (r.payoutCents === 0) nZero++;
    const zeroRowFraction = nZero / result.rows.length;
    // Tolerance ±5% of (1 − targetHitRate).
    expect(zeroRowFraction).toBeGreaterThan(0.75);
    expect(zeroRowFraction).toBeLessThan(0.85);
  });

  it('8. caps single-row RTP contribution to maxRowRtpShare', () => {
    const rng = makeRng(8);
    const rows: LookupRow[] = new Array(200_000);
    for (let i = 0; i < 200_000; i++) {
      const u = rng();
      let p = 0;
      if (u > 0.7) p = Math.floor(rng() * 200);
      if (u > 0.97) p = Math.floor(rng() * 50_000);
      if (u > 0.9995) p = Math.floor(rng() * 5_000_000);
      rows[i] = { sim: i, weight: 1 + Math.floor(rng() * 100), payoutCents: p };
    }

    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.005,
      targetCV: 8.0, toleranceCV: 1.0,
      targetHitRate: 0.30, toleranceHitRate: 0.02,
      capMaxWin: 5_000_000,
      nRowsOut: 10_000,
      requireMaxReached: true,
      maxRowRtpShare: 0.05,
      maxWeightPerRow: Infinity,  // isolate RTP-share cap from weight cap
      maxIterations: 2,
    });

    expect(result.maxRowRtpShare).toBeLessThanOrEqual(0.05 + 0.001);  // tiny epsilon for quantize rounding
    expect(result.toleranceMet.rtpConcentration).toBe(true);
  });

  it('9. respects maxRowRtpShare=1.0 (disabled cap, preserves old behavior)', () => {
    const rng = makeRng(9);
    const rows: LookupRow[] = [];
    for (let i = 0; i < 5000; i++) {
      rows.push({ sim: i, weight: 1, payoutCents: rng() > 0.7 ? Math.floor(rng() * 5000) : 0 });
    }
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.5, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.3, toleranceHitRate: 0.5,
      capMaxWin: 5000,
      nRowsOut: 500,
      requireMaxReached: false,
      maxRowRtpShare: 1.0,
      maxIterations: 2,
    });
    // With disabled cap, no warning about concentration
    expect(result.warnings.find(w => w.includes('maxRowRtpShare'))).toBeUndefined();
  });

  it('10. stakeReport — basic metrics and topKShare structure', () => {
    // Simple input: 1000 rows, mix of zero/small/large payouts
    const rng = makeRng(10);
    const rows: LookupRow[] = [];
    for (let i = 0; i < 5000; i++) {
      let p = 0;
      const u = rng();
      if (u > 0.7) p = Math.floor(rng() * 1000);
      if (u > 0.97) p = Math.floor(rng() * 50_000);
      rows.push({ sim: i, weight: 1 + Math.floor(rng() * 100), payoutCents: p });
    }

    const result = optimizeLookupTable(rows, {
      targetRTP: 0.5, toleranceRTP: 0.2,
      targetCV: 3, toleranceCV: 5,
      targetHitRate: 0.3, toleranceHitRate: 0.1,
      capMaxWin: 50_000,
      nRowsOut: 500,
      requireMaxReached: false,
      maxIterations: 1,
    });

    expect(result.stakeReport).toBeDefined();
    expect(result.stakeReport.betCostCents).toBe(100); // default
    expect(result.stakeReport.payoutMultMax).toBeCloseTo(result.achieved.maxPayout / 100, 6);
    expect(result.stakeReport.baseStd).toBeGreaterThanOrEqual(0);
    expect(result.stakeReport.prob5K).toBeGreaterThanOrEqual(0);
    expect(result.stakeReport.prob5K).toBeLessThanOrEqual(1);
    expect(result.stakeReport.prob10K).toBeLessThanOrEqual(result.stakeReport.prob5K);

    // topKShare should have entries for K=1, 5, 10, 100
    expect(result.stakeReport.topKShare.map(t => t.k)).toEqual([1, 5, 10, 100]);
    // Monotonically non-decreasing
    for (let i = 1; i < result.stakeReport.topKShare.length; i++) {
      expect(result.stakeReport.topKShare[i].share).toBeGreaterThanOrEqual(
        result.stakeReport.topKShare[i - 1].share,
      );
    }
    // Top-1 share matches maxRowRtpShare exactly
    expect(result.stakeReport.topKShare[0].share).toBeCloseTo(result.maxRowRtpShare, 6);
  });

  it('11. stakeReport — respects betCostCents parameter', () => {
    const rows: LookupRow[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push({
        sim: i,
        weight: 10,
        payoutCents: i % 5 === 0 ? Math.floor(Math.random() * 5000) : 0,
      });
    }

    // With betCostCents = 100, max payout 5000 → payoutMultMax = 50
    const r1 = optimizeLookupTable(rows, {
      targetRTP: 0.1, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.2, toleranceHitRate: 0.5,
      capMaxWin: 5000,
      nRowsOut: 200,
      requireMaxReached: false,
      maxIterations: 1,
      betCostCents: 100,
    });
    expect(r1.stakeReport.payoutMultMax).toBeCloseTo(r1.achieved.maxPayout / 100, 6);

    // With betCostCents = 200, multipliers halve
    const r2 = optimizeLookupTable(rows, {
      targetRTP: 0.1, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.2, toleranceHitRate: 0.5,
      capMaxWin: 5000,
      nRowsOut: 200,
      requireMaxReached: false,
      maxIterations: 1,
      betCostCents: 200,
    });
    expect(r2.stakeReport.payoutMultMax).toBeCloseTo(r2.achieved.maxPayout / 200, 6);
    expect(r2.stakeReport.baseStd).toBeCloseTo(r1.stakeReport.baseStd / 2, 5);
  });

  it('12. caps single-row weight to maxWeightPerRow × prior', () => {
    const rng = makeRng(12);
    const rows: LookupRow[] = new Array(100_000);
    for (let i = 0; i < 100_000; i++) {
      const u = rng();
      let p = 0;
      if (u > 0.7) p = Math.floor(rng() * 200);
      if (u > 0.97) p = Math.floor(rng() * 50_000);
      if (u > 0.9995) p = Math.floor(rng() * 1_000_000);
      rows[i] = { sim: i, weight: 1 + Math.floor(rng() * 100), payoutCents: p };
    }

    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.01,
      targetCV: 5.0, toleranceCV: 2.0,
      targetHitRate: 0.20, toleranceHitRate: 0.05,
      capMaxWin: 1_000_000,
      nRowsOut: 1000,
      requireMaxReached: false,
      maxWeightPerRow: 10,           // cap at 10× prior
      maxIterations: 2,
    });

    const uniformPrior = (1000 * 1_000_000) / 1000; // = 1_000_000
    const maxAllowedWeight = 10 * uniformPrior;
    for (const r of result.rows) {
      expect(r.weight).toBeLessThanOrEqual(maxAllowedWeight + 1);
    }
    expect(result.maxWeightRatio).toBeLessThanOrEqual(10 + 1e-6);
    expect(result.toleranceMet.weightCap).toBe(true);
  });

  it('13. maxWeightPerRow=Infinity disables the cap (preserves old behavior)', () => {
    const rng = makeRng(13);
    const rows: LookupRow[] = new Array(50_000);
    for (let i = 0; i < 50_000; i++) {
      rows[i] = { sim: i, weight: 1, payoutCents: rng() > 0.7 ? Math.floor(rng() * 5000) : 0 };
    }
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.5, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.3, toleranceHitRate: 0.5,
      capMaxWin: 5000,
      nRowsOut: 1000,
      requireMaxReached: false,
      maxWeightPerRow: Infinity,
      maxIterations: 1,
    });
    // No weight-cap warning when disabled
    expect(result.warnings.find(w => w.includes('maxWeightPerRow'))).toBeUndefined();
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
