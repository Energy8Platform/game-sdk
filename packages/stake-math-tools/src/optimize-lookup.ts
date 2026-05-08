// src/optimize-lookup.ts
import type {
  LookupRow,
  OptimizeParams,
  OptimizeResult,
  OptimizeAchieved,
  ToleranceMet,
} from './types.js';
import { computeMetrics, isNearMax } from './metrics.js';
import { bucketize } from './bucketize.js';
import { mulberry32, computeQuotas, stratifiedSample, weightedReservoirSample } from './sample.js';
import { solveNNLS } from './nnls.js';
import { quantizeWeights } from './quantize.js';

const DEFAULTS = {
  requireMaxReached: true,
  maxReachedFraction: 0.95,
  totalWeightOutPerRow: 1_000_000,
  seed: 0xC0FFEE,
  maxIterations: 5,
  bucketCount: 100,
  minPerBucket: 3,
};

export function optimizeLookupTable(
  rowsIn: Iterable<LookupRow>,
  params: OptimizeParams,
): OptimizeResult {
  const requireMaxReached = params.requireMaxReached ?? DEFAULTS.requireMaxReached;
  const maxReachedFraction = params.maxReachedFraction ?? DEFAULTS.maxReachedFraction;
  const totalWeightOut = params.totalWeightOut ?? params.nRowsOut * DEFAULTS.totalWeightOutPerRow;
  const seed = params.seed ?? DEFAULTS.seed;
  const maxIterations = params.maxIterations ?? DEFAULTS.maxIterations;
  const bucketCount = params.bucketCount ?? DEFAULTS.bucketCount;
  let minPerBucket = params.minPerBucket ?? DEFAULTS.minPerBucket;

  const warnings: string[] = [];

  // ── Phase 1: filter + materialize ─────────────────────────────────────────────
  const filtered: LookupRow[] = [];
  for (const r of rowsIn) {
    if (r.payoutCents > params.capMaxWin) continue;
    filtered.push(r);
  }
  if (filtered.length < params.nRowsOut) {
    throw new Error(
      `optimizeLookupTable: filtered input has ${filtered.length} rows, fewer than nRowsOut=${params.nRowsOut}`,
    );
  }
  if (totalWeightOut < params.nRowsOut) {
    throw new Error(
      `optimizeLookupTable: totalWeightOut (${totalWeightOut}) must be >= nRowsOut (${params.nRowsOut})`,
    );
  }

  // Source statistics for early infeasibility warnings
  const sourceMetrics = computeMetrics(filtered);
  if (sourceMetrics.rtp < params.targetRTP - params.toleranceRTP) {
    warnings.push(
      `source RTP (${sourceMetrics.rtp.toFixed(4)}) is below targetRTP (${params.targetRTP}) − tolerance; result may miss target`,
    );
  }
  if (sourceMetrics.maxPayout < maxReachedFraction * params.capMaxWin && requireMaxReached) {
    warnings.push(
      `no row reaches ${maxReachedFraction * 100}% of capMaxWin; requireMaxReached cannot be honored`,
    );
  }

  // ── Phases 2–6: try, expand, retry ────────────────────────────────────────────
  let best: { rows: LookupRow[]; achieved: OptimizeAchieved; toleranceMet: ToleranceMet; lossSum: number } | null = null;

  for (let iter = 0; iter < maxIterations; iter++) {
    const rng = mulberry32(seed + iter);
    const buckets = bucketize(filtered, {
      capMaxWin: params.capMaxWin,
      bucketCount,
      maxReachedFraction,
    });
    const quotas = computeQuotas(buckets, {
      nRowsOut: params.nRowsOut,
      minPerBucket,
      requireMaxReached,
    });
    let sampledIdx = stratifiedSample(buckets, filtered, quotas, rng);

    // Stratified sampling can come up short when buckets overlap (the near-max
    // bucket overlaps with the top log bucket). Top up with weighted-reservoir
    // sampling over the unsampled remainder so we always reach nRowsOut.
    if (sampledIdx.length < params.nRowsOut) {
      const chosen = new Set(sampledIdx);
      const remIdx: number[] = [];
      const remW: number[] = [];
      for (let i = 0; i < filtered.length; i++) {
        if (!chosen.has(i)) {
          remIdx.push(i);
          remW.push(filtered[i].weight);
        }
      }
      const need = params.nRowsOut - sampledIdx.length;
      const extras = weightedReservoirSample(remIdx, remW, need, rng);
      sampledIdx = sampledIdx.concat(extras);
    } else if (sampledIdx.length > params.nRowsOut) {
      // computeQuotas can oversubscribe when many non-empty log buckets each
      // claim minPerBucket slots beyond the nRowsOut budget. Trim deterministically:
      // keep the highest-weight candidates, breaking ties on sim, then on index.
      // We must preserve any near-max-bucket samples to honor requireMaxReached.
      const nearMaxSet = new Set(buckets.nearMaxBucket.indices);
      const mustKeep: number[] = [];
      const trimmable: number[] = [];
      for (const i of sampledIdx) {
        if (requireMaxReached && nearMaxSet.has(i) && mustKeep.length < params.nRowsOut) {
          mustKeep.push(i);
        } else {
          trimmable.push(i);
        }
      }
      const need = params.nRowsOut - mustKeep.length;
      trimmable.sort((a, b) => {
        const wd = filtered[b].weight - filtered[a].weight;
        if (wd !== 0) return wd;
        const sd = filtered[a].sim - filtered[b].sim;
        if (sd !== 0) return sd;
        return a - b;
      });
      sampledIdx = mustKeep.concat(trimmable.slice(0, Math.max(0, need)));
    }

    if (sampledIdx.length !== params.nRowsOut) {
      // Quota arithmetic failed (very rare — input too sparse); retry with relaxed minPerBucket
      minPerBucket = Math.max(1, minPerBucket - 1);
      continue;
    }

    const candidates = sampledIdx.map((i) => filtered[i]);

    // Build A, b for NNLS — feature rows: RTP, var (using μ̂), hit-rate, sum
    // Each feature row scaled by 1/tolerance so loss is "tolerance-units".
    const muHatTarget = params.targetRTP * 100;
    let muHat = muHatTarget;
    let weights: number[] = [];

    for (let inner = 0; inner < 5; inner++) {
      const A: number[][] = [
        // RTP row: payouts (cents), scaled
        candidates.map((r) => r.payoutCents / params.toleranceRTP),
        // CV row: (payout − μ̂)², scaled — note we encode CV² via variance = CV² · μ²
        candidates.map((r) => Math.pow(r.payoutCents - muHat, 2) / Math.max(1, params.toleranceCV * muHat * muHat)),
        // Hit-rate row: 1 if payout > 0
        candidates.map((r) => (r.payoutCents > 0 ? 1 : 0) / params.toleranceHitRate),
        // Sum row: 1 — heavily weighted (1/tolerance set very small ≡ very strict)
        candidates.map(() => 1 / 1e-6),
      ];
      const bVec = [
        (params.targetRTP * totalWeightOut * 100) / params.toleranceRTP,
        (Math.pow(params.targetCV * muHat, 2) * totalWeightOut) / Math.max(1, params.toleranceCV * muHat * muHat),
        (params.targetHitRate * totalWeightOut) / params.toleranceHitRate,
        totalWeightOut / 1e-6,
      ];

      const prior = new Array(candidates.length).fill(totalWeightOut / candidates.length);
      const sol = solveNNLS(A, bVec, {
        prior,
        regularization: 1e-6,
        maxIterations: 200,
      });
      weights = sol;

      // Update μ̂
      let sumW = 0;
      let sumWP = 0;
      for (let i = 0; i < candidates.length; i++) {
        sumW += sol[i];
        sumWP += sol[i] * candidates[i].payoutCents;
      }
      const newMu = sumW > 0 ? sumWP / sumW : muHatTarget;
      if (Math.abs(newMu - muHat) < 1e-3) {
        muHat = newMu;
        break;
      }
      muHat = newMu;
    }

    // Quantize
    const quantized = quantizeWeights(weights, totalWeightOut);
    const outRows: LookupRow[] = candidates.map((r, i) => ({
      sim: r.sim,
      weight: quantized[i],
      payoutCents: r.payoutCents,
    }));

    const achieved = computeMetrics(outRows);
    const toleranceMet: ToleranceMet = {
      rtp: Math.abs(achieved.rtp - params.targetRTP) <= params.toleranceRTP,
      cv: Math.abs(achieved.cv - params.targetCV) <= params.toleranceCV,
      hitRate: Math.abs(achieved.hitRate - params.targetHitRate) <= params.toleranceHitRate,
      maxReached:
        !requireMaxReached ||
        outRows.some((r) => isNearMax(r.payoutCents, params.capMaxWin, maxReachedFraction)),
    };

    // Loss for "best so far" tracking — Σ tolerance-normalized squared misses
    let lossSum =
      Math.pow((achieved.rtp - params.targetRTP) / params.toleranceRTP, 2) +
      Math.pow((achieved.cv - params.targetCV) / params.toleranceCV, 2) +
      Math.pow((achieved.hitRate - params.targetHitRate) / params.toleranceHitRate, 2) +
      (toleranceMet.maxReached ? 0 : 1000);
    if (!Number.isFinite(lossSum)) lossSum = Infinity;

    if (!best || lossSum < best.lossSum) {
      best = { rows: outRows, achieved, toleranceMet, lossSum };
    }

    if (toleranceMet.rtp && toleranceMet.cv && toleranceMet.hitRate && toleranceMet.maxReached) {
      return { rows: outRows, achieved, toleranceMet, warnings };
    }
  }

  // Fell through max iterations — return best-effort
  if (!best) throw new Error('optimizeLookupTable: failed to produce any candidate');

  if (!best.toleranceMet.rtp) {
    warnings.push(
      `RTP off target by ${(best.achieved.rtp - params.targetRTP).toFixed(6)} (tolerance ${params.toleranceRTP})`,
    );
  }
  if (!best.toleranceMet.cv) {
    warnings.push(
      `CV off target by ${(best.achieved.cv - params.targetCV).toFixed(4)} (tolerance ${params.toleranceCV})`,
    );
  }
  if (!best.toleranceMet.hitRate) {
    warnings.push(
      `hitRate off target by ${(best.achieved.hitRate - params.targetHitRate).toFixed(4)} (tolerance ${params.toleranceHitRate})`,
    );
  }
  if (!best.toleranceMet.maxReached) {
    warnings.push(`requireMaxReached=true but no near-max row in output`);
  }

  return { rows: best.rows, achieved: best.achieved, toleranceMet: best.toleranceMet, warnings };
}
