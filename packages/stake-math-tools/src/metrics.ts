// src/metrics.ts
import type { LookupRow, OptimizeAchieved } from './types.js';

/**
 * Computes weighted aggregate metrics over an array of rows.
 *
 * RTP = Σ(w·payout) / (Σw · 100)            // payout is cents-int (×100), bet unit = 100 cents
 * mean = Σ(w·payout) / Σw
 * var  = Σ(w·(payout − mean)²) / Σw
 * CV   = √var / mean                        // 0 when mean = 0
 * hitRate = Σ_{payout>0} w / Σw
 *
 * Uses BigInt for the Σ accumulators to be safe against overflow on large input
 * weights (e.g. ~2e11 per row × 10M rows × payout² up to 1e12 ≈ 2e33).
 */
export function computeMetrics(rows: ReadonlyArray<LookupRow>): OptimizeAchieved {
  let totalW = 0n;
  let sumWPayout = 0n;
  let sumWPayout2 = 0n;
  let nonzeroW = 0n;
  let maxPayout = 0;

  for (const r of rows) {
    const w = BigInt(r.weight);
    const p = BigInt(r.payoutCents);
    totalW += w;
    sumWPayout += w * p;
    sumWPayout2 += w * p * p;
    if (r.payoutCents > 0) nonzeroW += w;
    if (r.payoutCents > maxPayout) maxPayout = r.payoutCents;
  }

  const totalWeight = Number(totalW);
  if (totalWeight === 0) {
    return { rtp: 0, cv: 0, hitRate: 0, maxPayout: 0, totalWeight: 0 };
  }

  const mean = Number(sumWPayout) / totalWeight;
  const meanSq = Number(sumWPayout2) / totalWeight;
  const variance = Math.max(0, meanSq - mean * mean);
  const stddev = Math.sqrt(variance);

  return {
    rtp: mean / 100,
    cv: mean === 0 ? 0 : stddev / mean,
    hitRate: Number(nonzeroW) / totalWeight,
    maxPayout,
    totalWeight,
  };
}

/** True when payout reaches the configured fraction of the cap. */
export function isNearMax(payoutCents: number, capMaxWin: number, fraction: number): boolean {
  return payoutCents >= fraction * capMaxWin;
}
