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
import { buildTieredLookup } from './tiered.js';
import { computeStakeReport, detectHitRateGaps } from './stake-report.js';

function emitGapWarning(stakeReport: ReturnType<typeof computeStakeReport>, warnings: string[]): void {
  const gaps = detectHitRateGaps(stakeReport.hitRateDistribution);
  if (gaps.length > 0) {
    const formatted = gaps.map((g) => `[${g.low}, ${g.high})`).join(', ');
    warnings.push(
      `hit-rate distribution has ${gaps.length} intermediate gap(s) — Stake "Gaps in the Hit Rate Table" check may fail: ${formatted}`,
    );
  }
}

const DEFAULTS = {
  requireMaxReached: true,
  maxReachedFraction: 0.95,
  totalWeightOutPerRow: 1_000_000,
  seed: 0xC0FFEE,
  maxIterations: 5,
  bucketCount: 100,
  minPerBucket: 3,
  maxRowRtpShare: 0.05,
  maxWeightPerRow: 10,
  betCostCents: 100,
};

export function optimizeLookupTable(
  rowsIn: Iterable<LookupRow>,
  params: OptimizeParams,
): OptimizeResult {
  const algorithm = params.algorithm ?? 'tiered';
  if (algorithm === 'tiered') {
    return buildTieredLookup(rowsIn, params);
  }

  const requireMaxReached = params.requireMaxReached ?? DEFAULTS.requireMaxReached;
  const maxReachedFraction = params.maxReachedFraction ?? DEFAULTS.maxReachedFraction;
  const totalWeightOut = params.totalWeightOut ?? params.nRowsOut * DEFAULTS.totalWeightOutPerRow;
  const seed = params.seed ?? DEFAULTS.seed;
  const maxIterations = params.maxIterations ?? DEFAULTS.maxIterations;
  const bucketCount = params.bucketCount ?? DEFAULTS.bucketCount;
  let minPerBucket = params.minPerBucket ?? DEFAULTS.minPerBucket;
  const maxRowRtpShare = params.maxRowRtpShare ?? DEFAULTS.maxRowRtpShare;
  const maxWeightPerRow = params.maxWeightPerRow ?? DEFAULTS.maxWeightPerRow;
  const betCostCents = params.betCostCents ?? DEFAULTS.betCostCents;

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
        maxWeightRatio: number;
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

    // ── Iterative RTP-share + per-row weight cap (Stake Engine "Within Liability Limits") ─
    //
    // After NNLS converges, one or a few rows may dominate the total RTP, or a single
    // row may absorb enormous weight (zero-payout or near-zero-payout filler rows used
    // to satisfy hit-rate / total-weight constraints cheaply). Stake Engine rejects
    // tables where a single row carries an oversized share of expected return OR
    // oversized weight (the Expected Tail Liability check). We iteratively cap any
    // violating row and re-solve the (smaller) NNLS problem on the remaining rows
    // until no violator remains or the iteration budget is exhausted.
    const maxAllowedWeight = Number.isFinite(maxWeightPerRow)
      ? maxWeightPerRow * (totalWeightOut / candidates.length)
      : Infinity;
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

      // Find violators (only among non-fixed rows). We check BOTH the RTP-share
      // cap and the absolute per-row weight cap; either constraint suffices.
      const violators: number[] = [];
      for (let i = 0; i < candidates.length; i++) {
        if (fixedWeight.has(i)) continue;
        const w = weights[i];
        const p = candidates[i].payoutCents;
        const exceedsRtpShare =
          totalWP > 0 && (w * p) / totalWP > maxRowRtpShare;
        const exceedsWeight = w > maxAllowedWeight;
        if (exceedsRtpShare || exceedsWeight) violators.push(i);
      }
      if (violators.length === 0) {
        capConverged = true;
        break;
      }

      // Cap each violator at the TIGHTEST applicable bound: RTP-share-derived
      // limit (only meaningful for nonzero-payout rows) intersected with the
      // absolute weight cap. Truncate to integer.
      for (const i of violators) {
        const p = candidates[i].payoutCents;
        let cap = maxAllowedWeight;
        if (p > 0 && totalWP > 0) {
          const rtpCap = (maxRowRtpShare * totalWP) / p;
          if (rtpCap < cap) cap = rtpCap;
        }
        const cappedW = Math.max(1, Math.floor(cap));
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
        ? `maxRowRtpShare / maxWeightPerRow cap could not converge in ${maxCapIters} iterations`
        : undefined;

    // Quantize
    const quantized = quantizeWeights(weights, totalWeightOut);

    // Post-quantize weight-cap enforcement: largest-remainder quantization can
    // redistribute integer mass onto any row, potentially pushing capped rows
    // (or previously-uncapped rows) above maxAllowedWeight. Walk the array
    // greedily: peel excess off over-cap rows and pour it onto rows below cap.
    //
    // Recipient preference order:
    //   1. Zero-payout rows (safe — don't disturb RTP-share cap), ordered by
    //      smallest current weight first (preserve shape).
    //   2. Non-zero-payout rows, ordered by largest RTP-share headroom first
    //      (i.e., lowest current rtpShare / payout ratio) so we minimize the
    //      risk of pushing a row past maxRowRtpShare.
    if (Number.isFinite(maxAllowedWeight)) {
      const intCap = Math.max(1, Math.floor(maxAllowedWeight));
      let totalExcess = 0;
      for (let i = 0; i < quantized.length; i++) {
        if (quantized[i] > intCap) {
          totalExcess += quantized[i] - intCap;
          quantized[i] = intCap;
        }
      }
      if (totalExcess > 0) {
        // Recompute current totalWP for per-row RTP-share bookkeeping. We need
        // an upper bound on what totalWP could become after redistribution:
        // pouring excess onto non-zero rows can only grow totalWP. Use the
        // pre-redistribution snapshot (conservative — gives smaller rtpCapWP)
        // and apply a safety margin of 95% to leave headroom for quantization
        // and totalWP drift during pouring.
        let curTotalWP = 0;
        for (let i = 0; i < quantized.length; i++) {
          curTotalWP += quantized[i] * candidates[i].payoutCents;
        }
        const rtpCapWP = 0.95 * maxRowRtpShare * Math.max(curTotalWP, 1);

        // Bucket 1: zero-payout rows.
        const zeroRecipients: number[] = [];
        // Bucket 2: non-zero-payout rows with RTP-share headroom.
        const nonZeroRecipients: number[] = [];
        for (let i = 0; i < quantized.length; i++) {
          if (quantized[i] >= intCap) continue;
          if (candidates[i].payoutCents === 0) {
            zeroRecipients.push(i);
          } else {
            nonZeroRecipients.push(i);
          }
        }
        zeroRecipients.sort((a, b) => quantized[a] - quantized[b]);
        // Sort non-zero recipients by current w·p ascending (most headroom first).
        nonZeroRecipients.sort(
          (a, b) =>
            quantized[a] * candidates[a].payoutCents -
            quantized[b] * candidates[b].payoutCents,
        );

        const pour = (recipients: number[], respectRtpCap: boolean): void => {
          for (const r of recipients) {
            if (totalExcess === 0) return;
            const headroom = intCap - quantized[r];
            if (headroom <= 0) continue;
            let give = Math.min(headroom, totalExcess);
            if (respectRtpCap) {
              const p = candidates[r].payoutCents;
              if (p > 0) {
                const curWP = quantized[r] * p;
                const maxAddWP = rtpCapWP - curWP;
                if (maxAddWP <= 0) continue;
                const maxAddW = Math.floor(maxAddWP / p);
                if (maxAddW <= 0) continue;
                give = Math.min(give, maxAddW);
              }
            }
            quantized[r] += give;
            totalExcess -= give;
          }
        };

        pour(zeroRecipients, false);
        pour(nonZeroRecipients, true);
        // If excess remains, fall back to any below-cap row (cap was infeasible
        // for this nRowsOut / totalWeightOut combination). toleranceMet.weightCap
        // computed below reflects the actual result.
        if (totalExcess > 0) {
          pour(nonZeroRecipients, false);
        }
      }
    }

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

    // Compute max single-row weight ratio (as a multiple of uniform prior).
    const uniformPrior = totalWeightOut / outRows.length;
    let maxWeightObs = 0;
    for (const r of outRows) {
      if (r.weight > maxWeightObs) maxWeightObs = r.weight;
    }
    const maxWeightRatio = uniformPrior > 0 ? maxWeightObs / uniformPrior : 0;

    const toleranceMet: ToleranceMet = {
      rtp: Math.abs(achieved.rtp - params.targetRTP) <= params.toleranceRTP,
      cv: Math.abs(achieved.cv - params.targetCV) <= params.toleranceCV,
      hitRate: Math.abs(achieved.hitRate - params.targetHitRate) <= params.toleranceHitRate,
      maxReached:
        !requireMaxReached ||
        outRows.some((r) => isNearMax(r.payoutCents, params.capMaxWin, maxReachedFraction)),
      rtpConcentration: maxRowShare <= maxRowRtpShare,
      weightCap: maxWeightRatio <= maxWeightPerRow + 1e-6,
    };

    // Loss for "best so far" tracking — Σ tolerance-normalized squared misses
    let lossSum =
      Math.pow((achieved.rtp - params.targetRTP) / params.toleranceRTP, 2) +
      Math.pow((achieved.cv - params.targetCV) / params.toleranceCV, 2) +
      Math.pow((achieved.hitRate - params.targetHitRate) / params.toleranceHitRate, 2) +
      (toleranceMet.maxReached ? 0 : 1000) +
      (toleranceMet.rtpConcentration ? 0 : 1000) +
      (toleranceMet.weightCap ? 0 : 1000);
    if (!Number.isFinite(lossSum)) lossSum = Infinity;

    if (!best || lossSum < best.lossSum) {
      best = {
        rows: outRows,
        achieved,
        toleranceMet,
        maxRowShare,
        maxWeightRatio,
        lossSum,
        capWarning,
      };
    }

    if (
      toleranceMet.rtp &&
      toleranceMet.cv &&
      toleranceMet.hitRate &&
      toleranceMet.maxReached &&
      toleranceMet.rtpConcentration &&
      toleranceMet.weightCap
    ) {
      const iterWarnings = warnings.slice();
      if (capWarning) iterWarnings.push(capWarning);
      const successReport = computeStakeReport(outRows, achieved, betCostCents);
      emitGapWarning(successReport, iterWarnings);
      return {
        rows: outRows,
        achieved,
        toleranceMet,
        maxRowRtpShare: maxRowShare,
        maxWeightRatio,
        refinement: { rtpSwaps: 0, cvSwaps: 0, gapFillSwaps: 0, gapsUnfillable: 0 },
        warnings: iterWarnings,
        stakeReport: successReport,
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
  if (!best.toleranceMet.weightCap) {
    warnings.push(
      `maxWeightPerRow exceeded: max weight ratio ${best.maxWeightRatio.toFixed(2)} > ${maxWeightPerRow} × uniform prior`,
    );
  }
  if (best.capWarning) warnings.push(best.capWarning);

  const bestReport = computeStakeReport(best.rows, best.achieved, betCostCents);
  emitGapWarning(bestReport, warnings);
  return {
    rows: best.rows,
    achieved: best.achieved,
    toleranceMet: best.toleranceMet,
    maxRowRtpShare: best.maxRowShare,
    maxWeightRatio: best.maxWeightRatio,
    refinement: { rtpSwaps: 0, cvSwaps: 0, gapFillSwaps: 0, gapsUnfillable: 0 },
    warnings,
    stakeReport: bestReport,
  };
}
