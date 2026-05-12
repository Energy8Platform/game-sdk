import { describe, expect, it } from 'vitest';
import { optimizeLookupTable } from '../src/optimize-lookup.js';
import type { LookupRow } from '../src/types.js';

function genRows(n: number, rng: () => number, capCents: number): LookupRow[] {
  // Mix of zero, small, and occasional large payouts
  const rows: LookupRow[] = [];
  for (let i = 0; i < n; i++) {
    const u = rng();
    let payoutCents = 0;
    if (u > 0.7) payoutCents = Math.floor(rng() * 200);            // small win
    if (u > 0.95) payoutCents = Math.floor(rng() * 5_000);         // medium win
    if (u > 0.999) payoutCents = Math.floor(rng() * capCents);     // big win
    rows.push({ sim: i, weight: 1 + Math.floor(rng() * 100), payoutCents });
  }
  return rows;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('optimizeLookupTable', () => {
  it('returns exactly nRowsOut rows with integer weights summing to totalWeightOut', () => {
    const rows = genRows(2000, rng(1), 100_000);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.01,
      targetCV: 5.0, toleranceCV: 1.0,
      targetHitRate: 0.3, toleranceHitRate: 0.05,
      capMaxWin: 100_000,
      nRowsOut: 100,
      algorithm: 'nnls',
    });
    expect(result.rows).toHaveLength(100);
    let sum = 0;
    for (const r of result.rows) {
      expect(Number.isInteger(r.weight)).toBe(true);
      expect(r.weight).toBeGreaterThanOrEqual(1);
      sum += r.weight;
    }
    expect(sum).toBe(100 * 1_000_000); // default totalWeightOut
  });

  it('drops rows with payout > capMaxWin from candidate pool', () => {
    const rows: LookupRow[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ sim: i, weight: 10, payoutCents: 0 })),
      { sim: 999, weight: 1, payoutCents: 999_999 }, // way above cap
    ];
    const result = optimizeLookupTable(rows, {
      targetRTP: 0, toleranceRTP: 0.01,
      targetCV: 0.1, toleranceCV: 1,
      targetHitRate: 0.05, toleranceHitRate: 0.5,
      capMaxWin: 1000,
      nRowsOut: 50,
      requireMaxReached: false,
    });
    expect(result.rows.find((r) => r.sim === 999)).toBeUndefined();
  });

  it('emits a warning and toleranceMet=false when target is infeasible', () => {
    // All payouts zero → CV=0 always; targetCV=10 is infeasible
    const rows: LookupRow[] = Array.from({ length: 200 }, (_, i) => ({
      sim: i, weight: 1, payoutCents: 0,
    }));
    const result = optimizeLookupTable(rows, {
      targetRTP: 0, toleranceRTP: 0.0001,
      targetCV: 10, toleranceCV: 0.1,
      targetHitRate: 0, toleranceHitRate: 0.0001,
      capMaxWin: 1000,
      nRowsOut: 50,
      requireMaxReached: false,
      maxIterations: 2,
      algorithm: 'nnls',
    });
    expect(result.toleranceMet.cv).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('honors requireMaxReached when a near-max row exists', () => {
    const rows: LookupRow[] = [
      ...Array.from({ length: 500 }, (_, i) => ({ sim: i, weight: 100, payoutCents: 0 })),
      ...Array.from({ length: 50 }, (_, i) => ({ sim: 1000 + i, weight: 10, payoutCents: 100 })),
      { sim: 9999, weight: 1, payoutCents: 990 }, // near-max for cap=1000
    ];
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.5,    // very loose, just exercising near-max
      targetCV: 5, toleranceCV: 100,
      targetHitRate: 0.1, toleranceHitRate: 0.5,
      capMaxWin: 1000,
      maxReachedFraction: 0.95,
      requireMaxReached: true,
      nRowsOut: 100,
    });
    expect(result.toleranceMet.maxReached).toBe(true);
    expect(result.rows.find((r) => r.sim === 9999)).toBeDefined();
  });

  it('produces deterministic output for a fixed seed', () => {
    const rows = genRows(1000, rng(42), 10_000);
    const params = {
      targetRTP: 0.5, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.3, toleranceHitRate: 0.5,
      capMaxWin: 10_000,
      nRowsOut: 50,
      seed: 1234,
    };
    const a = optimizeLookupTable(rows, params);
    const b = optimizeLookupTable(rows, params);
    expect(a.rows.map((r) => r.sim)).toEqual(b.rows.map((r) => r.sim));
    expect(a.rows.map((r) => r.weight)).toEqual(b.rows.map((r) => r.weight));
  });
});
