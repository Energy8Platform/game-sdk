import type { LookupRow, OptimizeAchieved, StakeReport, TopKShare, HitRateBucket } from './types.js';

/**
 * Stake's hit-rate distribution table boundaries (payout multipliers).
 * Mirrors the ranges shown in Stake Engine's publish UI under
 * "Hit-Rate Ranges". Stake flags any intermediate empty range as a gap.
 *
 * Note: Stake displays the first range as `[0, 0.1)` (closed-open) — this
 * captures zero-payout rows. All other ranges are `[low, high)` here for
 * consistency; the last entry is `[20000, ∞)`.
 */
export const HIT_RATE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.1],
  [0.1, 1],
  [1, 2],
  [2, 5],
  [5, 10],
  [10, 20],
  [20, 50],
  [50, 100],
  [100, 200],
  [200, 500],
  [500, 1000],
  [1000, 2000],
  [2000, 5000],
  [5000, 10000],
  [10000, 20000],
  [20000, Infinity],
];

/**
 * Compute the full Stake-compatible report from a finalized lookup table.
 * Single source of truth for both tier-based and NNLS-based outputs.
 */
export function computeStakeReport(
  outRows: ReadonlyArray<LookupRow>,
  achieved: OptimizeAchieved,
  betCostCents: number,
): StakeReport {
  const threshold5K = 5000 * betCostCents;
  const threshold10K = 10000 * betCostCents;

  let w5K = 0n;
  let w10K = 0n;
  let wTotal = 0n;
  const uniquePayouts = new Set<number>();
  for (const r of outRows) {
    const w = BigInt(r.weight);
    wTotal += w;
    if (r.payoutCents >= threshold5K) w5K += w;
    if (r.payoutCents >= threshold10K) w10K += w;
    uniquePayouts.add(r.payoutCents);
  }
  const prob5K = wTotal > 0n ? Number(w5K) / Number(wTotal) : 0;
  const prob10K = wTotal > 0n ? Number(w10K) / Number(wTotal) : 0;

  // Top-K cumulative RTP shares (by w·payout descending)
  const wpEntries = outRows.map((r) => r.weight * r.payoutCents);
  let totalWP = 0;
  for (const v of wpEntries) totalWP += v;
  const sortedWP = wpEntries.slice().sort((a, b) => b - a);
  const topKShare: TopKShare[] = [];
  const Ks = [1, 5, 10, 100];
  let cum = 0;
  let kIdx = 0;
  for (let i = 0; i < sortedWP.length; i++) {
    cum += sortedWP[i];
    while (kIdx < Ks.length && i + 1 === Ks[kIdx]) {
      topKShare.push({ k: Ks[kIdx], share: totalWP > 0 ? cum / totalWP : 0 });
      kIdx++;
    }
    if (kIdx >= Ks.length) break;
  }
  while (kIdx < Ks.length) {
    topKShare.push({ k: Ks[kIdx], share: totalWP > 0 ? cum / totalWP : 0 });
    kIdx++;
  }

  // Hit-rate distribution table.
  // pm (payout multiplier) = payoutCents / betCostCents. Range [low, high).
  const counts = new Array<number>(HIT_RATE_RANGES.length).fill(0);
  const weights = new Array<bigint>(HIT_RATE_RANGES.length).fill(0n);
  for (const r of outRows) {
    const pm = r.payoutCents / betCostCents;
    for (let i = 0; i < HIT_RATE_RANGES.length; i++) {
      const [low, high] = HIT_RATE_RANGES[i];
      if (pm >= low && pm < high) {
        counts[i]++;
        weights[i] += BigInt(r.weight);
        break;
      }
    }
  }
  const totalWeightNum = Number(wTotal);
  const hitRateDistribution: HitRateBucket[] = HIT_RATE_RANGES.map(([low, high], i) => ({
    low,
    high,
    count: counts[i],
    effectiveHitRate: totalWeightNum > 0 ? Number(weights[i]) / totalWeightNum : 0,
  }));

  return {
    payoutMultMax: achieved.maxPayout / betCostCents,
    baseStd: (achieved.cv * achieved.rtp * 100) / betCostCents,
    prob5K,
    prob10K,
    topKShare,
    hitRateDistribution,
    uniqueEvents: uniquePayouts.size,
    betCostCents,
  };
}

/**
 * Returns the [low, high) ranges that are EMPTY but lie BETWEEN two non-empty
 * ranges. These are the "intermediate gaps" Stake's "Gaps in the Hit Rate
 * Table" check flags. Empty ranges above the highest non-empty range are
 * natural (the source distribution doesn't reach that far) and are not gaps.
 */
export function detectHitRateGaps(
  hitRateDistribution: ReadonlyArray<{ low: number; high: number; count: number }>,
): Array<{ low: number; high: number }> {
  // Find the index of the last non-empty range.
  let lastNonEmpty = -1;
  for (let i = hitRateDistribution.length - 1; i >= 0; i--) {
    if (hitRateDistribution[i].count > 0) {
      lastNonEmpty = i;
      break;
    }
  }
  if (lastNonEmpty < 0) return [];

  const gaps: Array<{ low: number; high: number }> = [];
  let seenNonEmpty = false;
  for (let i = 0; i <= lastNonEmpty; i++) {
    const b = hitRateDistribution[i];
    if (b.count > 0) {
      seenNonEmpty = true;
    } else if (seenNonEmpty) {
      gaps.push({ low: b.low, high: b.high });
    }
  }
  return gaps;
}

