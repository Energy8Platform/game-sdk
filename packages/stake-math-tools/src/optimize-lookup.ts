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
import { mulberry32, computeQuotas, stratifiedSample } from './sample.js';
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
  maxRowRtpShare: 0.05,
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
  const maxRowRtpShare = params.maxRowRtpShare ?? DEFAULTS.maxRowRtpShare;

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
  let best:
    | {
        rows: LookupRow[];
        achieved: OptimizeAchieved;
        toleranceMet: ToleranceMet;
        maxRowShare: number;
        lossSum: number;
        capWarning?: string;
      }
    | null = null;

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
      targetHitRate: params.targetHitRate,
    });
    const sampledIdx = stratifiedSample(buckets, filtered, quotas, rng);

    if (sampledIdx.length !== params.nRowsOut) {
      // Should not happen with fixed sample.ts (computeQuotas + stratifiedSample
      // honor their invariants); kept as defense in depth.
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

    // ── Iterative RTP-share cap (Stake Engine "Within Liability Limits") ─────
    //
    // After NNLS converges, one or a few rows may dominate the total RTP. Stake
    // Engine rejects tables where a single row carries an oversized share of the
    // expected return. We iteratively cap any such row's weight and re-solve the
    // (smaller) NNLS problem on the remaining rows until no violator remains or
    // the iteration budget is exhausted.
    const fixedWeight = new Map<number, number>(); // candidate index → fixed weight
    let capIters = 0;
    const maxCapIters = 50;
    let capConverged = false;

    while (capIters++ < maxCapIters) {
      // Compute current total w·p (including fixed contributions)
      let totalWP = 0;
      for (let i = 0; i < candidates.length; i++) {
        const w = fixedWeight.has(i) ? fixedWeight.get(i)! : weights[i];
        totalWP += w * candidates[i].payoutCents;
      }
      if (totalWP <= 0) {
        capConverged = true;
        break;
      }

      // Find violators (only among non-fixed rows)
      const violators: number[] = [];
      for (let i = 0; i < candidates.length; i++) {
        if (fixedWeight.has(i)) continue;
        const w = weights[i];
        const share = (w * candidates[i].payoutCents) / totalWP;
        if (share > maxRowRtpShare) violators.push(i);
      }
      if (violators.length === 0) {
        capConverged = true;
        break;
      }

      // Cap each violator at maxRowRtpShare × totalWP / payout (truncate to integer)
      for (const i of violators) {
        const p = candidates[i].payoutCents;
        const cappedW = Math.max(1, Math.floor((maxRowRtpShare * totalWP) / Math.max(1, p)));
        fixedWeight.set(i, cappedW);
      }

      // Re-run NNLS on remaining (non-fixed) candidates
      const remainingIdx: number[] = [];
      for (let i = 0; i < candidates.length; i++) {
        if (!fixedWeight.has(i)) remainingIdx.push(i);
      }
      if (remainingIdx.length < 4) break; // not enough rows to solve

      // Compute fixed contributions to subtract from b
      let fixedW_RTP = 0;
      let fixedW_CV = 0;
      let fixedW_HR = 0;
      let fixedW_Sum = 0;
      for (const [idx, w] of fixedWeight) {
        const p = candidates[idx].payoutCents;
        fixedW_RTP += (w * p) / params.toleranceRTP;
        fixedW_CV +=
          (w * Math.pow(p - muHat, 2)) / Math.max(1, params.toleranceCV * muHat * muHat);
        fixedW_HR += (w * (p > 0 ? 1 : 0)) / params.toleranceHitRate;
        fixedW_Sum += w / 1e-6;
      }

      // Build reduced A, b
      const remCandidates = remainingIdx.map((i) => candidates[i]);
      const A_r: number[][] = [
        remCandidates.map((r) => r.payoutCents / params.toleranceRTP),
        remCandidates.map(
          (r) =>
            Math.pow(r.payoutCents - muHat, 2) /
            Math.max(1, params.toleranceCV * muHat * muHat),
        ),
        remCandidates.map((r) => (r.payoutCents > 0 ? 1 : 0) / params.toleranceHitRate),
        remCandidates.map(() => 1 / 1e-6),
      ];
      const b_r = [
        (params.targetRTP * totalWeightOut * 100) / params.toleranceRTP - fixedW_RTP,
        (Math.pow(params.targetCV * muHat, 2) * totalWeightOut) /
          Math.max(1, params.toleranceCV * muHat * muHat) -
          fixedW_CV,
        (params.targetHitRate * totalWeightOut) / params.toleranceHitRate - fixedW_HR,
        totalWeightOut / 1e-6 - fixedW_Sum,
      ];

      let fixedTotalW = 0;
      for (const w of fixedWeight.values()) fixedTotalW += w;
      const remainingFreeWeight = Math.max(0, totalWeightOut - fixedTotalW);
      const remPrior = new Array(remCandidates.length).fill(
        Math.max(1, remainingFreeWeight / remCandidates.length),
      );
      const newSol = solveNNLS(A_r, b_r, {
        prior: remPrior,
        regularization: 1e-6,
        maxIterations: 200,
      });

      // Splice back into the full weights array
      for (let k = 0; k < remainingIdx.length; k++) {
        weights[remainingIdx[k]] = Math.max(0, newSol[k]);
      }
      for (const [idx, w] of fixedWeight) {
        weights[idx] = w;
      }
    }

    const capWarning =
      !capConverged && fixedWeight.size > 0
        ? `maxRowRtpShare cap could not converge in ${maxCapIters} iterations`
        : undefined;

    // Quantize
    const quantized = quantizeWeights(weights, totalWeightOut);
    const outRows: LookupRow[] = candidates.map((r, i) => ({
      sim: r.sim,
      weight: quantized[i],
      payoutCents: r.payoutCents,
    }));

    const achieved = computeMetrics(outRows);

    // Compute the max single-row RTP share from final quantized output
    let totalWPOut = 0;
    for (const r of outRows) totalWPOut += r.weight * r.payoutCents;
    let maxRowShare = 0;
    if (totalWPOut > 0) {
      for (const r of outRows) {
        const share = (r.weight * r.payoutCents) / totalWPOut;
        if (share > maxRowShare) maxRowShare = share;
      }
    }

    const toleranceMet: ToleranceMet = {
      rtp: Math.abs(achieved.rtp - params.targetRTP) <= params.toleranceRTP,
      cv: Math.abs(achieved.cv - params.targetCV) <= params.toleranceCV,
      hitRate: Math.abs(achieved.hitRate - params.targetHitRate) <= params.toleranceHitRate,
      maxReached:
        !requireMaxReached ||
        outRows.some((r) => isNearMax(r.payoutCents, params.capMaxWin, maxReachedFraction)),
      rtpConcentration: maxRowShare <= maxRowRtpShare,
    };

    // Loss for "best so far" tracking — Σ tolerance-normalized squared misses
    let lossSum =
      Math.pow((achieved.rtp - params.targetRTP) / params.toleranceRTP, 2) +
      Math.pow((achieved.cv - params.targetCV) / params.toleranceCV, 2) +
      Math.pow((achieved.hitRate - params.targetHitRate) / params.toleranceHitRate, 2) +
      (toleranceMet.maxReached ? 0 : 1000) +
      (toleranceMet.rtpConcentration ? 0 : 1000);
    if (!Number.isFinite(lossSum)) lossSum = Infinity;

    if (!best || lossSum < best.lossSum) {
      best = { rows: outRows, achieved, toleranceMet, maxRowShare, lossSum, capWarning };
    }

    if (
      toleranceMet.rtp &&
      toleranceMet.cv &&
      toleranceMet.hitRate &&
      toleranceMet.maxReached &&
      toleranceMet.rtpConcentration
    ) {
      const iterWarnings = warnings.slice();
      if (capWarning) iterWarnings.push(capWarning);
      return {
        rows: outRows,
        achieved,
        toleranceMet,
        maxRowRtpShare: maxRowShare,
        warnings: iterWarnings,
      };
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
  if (!best.toleranceMet.rtpConcentration) {
    warnings.push(
      `maxRowRtpShare exceeded: ${(best.maxRowShare * 100).toFixed(2)}% > ${(maxRowRtpShare * 100).toFixed(2)}%`,
    );
  }
  if (best.capWarning) warnings.push(best.capWarning);

  return {
    rows: best.rows,
    achieved: best.achieved,
    toleranceMet: best.toleranceMet,
    maxRowRtpShare: best.maxRowShare,
    warnings,
  };
}
