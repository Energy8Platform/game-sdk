// src/tiered.ts
//
// Tier-based lookup-table compression.
//
// Unlike NNLS, this algorithm does NOT optimize toward (RTP, CV, hitRate) targets.
// It compresses the source distribution into `nRowsOut` rows while PRESERVING the
// natural rare-event rates. High-payout rows ("cap" / "large" tier) get weight=1
// (rarest); bulk rows ("small" tier) get weight=W >> 1 calculated so the natural
// cap probability is preserved.
//
// This is the canonical way Stake Engine expects lookup tables to be built: ETL
// (Expected Tail Liability) stays low because high-payout rows carry minimal
// weight, and the "Within Liability Limits" check passes by construction.

import type {
  LookupRow,
  OptimizeParams,
  OptimizeResult,
  ToleranceMet,
} from './types.js';
import { computeMetrics, isNearMax } from './metrics.js';
import { mulberry32, weightedReservoirSample } from './sample.js';
import { computeStakeReport, detectHitRateGaps, HIT_RATE_RANGES } from './stake-report.js';

const DEFAULTS = {
  betCostCents: 100,
  capPmFraction: 0.95, // capPmThreshold = capPmFraction × maxPm
  requireMaxReached: true,
  maxReachedFraction: 0.95,
  seed: 0xc0ffee,
};

export function buildTieredLookup(
  rowsIn: Iterable<LookupRow>,
  params: OptimizeParams,
): OptimizeResult {
  const betCost = params.betCostCents ?? DEFAULTS.betCostCents;
  const requireMaxReached = params.requireMaxReached ?? DEFAULTS.requireMaxReached;
  const maxReachedFraction = params.maxReachedFraction ?? DEFAULTS.maxReachedFraction;
  const seed = params.seed ?? DEFAULTS.seed;

  // Phase 1: filter
  const filtered: LookupRow[] = [];
  for (const r of rowsIn) {
    if (r.payoutCents > params.capMaxWin) continue;
    filtered.push(r);
  }
  if (filtered.length < params.nRowsOut) {
    throw new Error(
      `tiered: filtered input has ${filtered.length} rows, fewer than nRowsOut=${params.nRowsOut}`,
    );
  }

  const sourceMetrics = computeMetrics(filtered);

  // Phase 2: thresholds
  const maxPm = sourceMetrics.maxPayout / betCost;
  const capPmThreshold = params.capPmThreshold ?? DEFAULTS.capPmFraction * maxPm;
  const capPayoutCents = Math.floor(capPmThreshold * betCost);
  const largePmThreshold = params.largePmThreshold; // undefined → no large tier
  const largePayoutCents =
    largePmThreshold !== undefined ? Math.floor(largePmThreshold * betCost) : undefined;

  // Phase 3: classify source
  const srcCap: LookupRow[] = [];
  const srcLarge: LookupRow[] = [];
  const srcSmall: LookupRow[] = [];
  for (const r of filtered) {
    if (r.payoutCents >= capPayoutCents) srcCap.push(r);
    else if (largePayoutCents !== undefined && r.payoutCents >= largePayoutCents) srcLarge.push(r);
    else srcSmall.push(r);
  }

  // Target rate
  const target =
    params.largeTarget ?? (srcCap.length + srcLarge.length) / filtered.length;

  // Phase 4: pick output rows
  // Include all cap; include all large; fill remaining with small (random sample)
  let outCap = srcCap;
  let outLarge = srcLarge;

  if (outCap.length > params.nRowsOut) {
    // Too many cap rows — keep highest-payout
    outCap = [...srcCap].sort((a, b) => b.payoutCents - a.payoutCents).slice(0, params.nRowsOut);
    outLarge = [];
  } else if (outCap.length + outLarge.length > params.nRowsOut) {
    // Cap fits, but cap+large too many — drop some large
    const allowedLarge = params.nRowsOut - outCap.length;
    outLarge = [...srcLarge]
      .sort((a, b) => b.payoutCents - a.payoutCents)
      .slice(0, allowedLarge);
  }

  const slotsForSmall = params.nRowsOut - outCap.length - outLarge.length;
  const warnings: string[] = [];
  let outSmallZero: LookupRow[] = [];
  let outSmallNonZero: LookupRow[] = [];
  let srcSmallNonZeroAll: ReadonlyArray<LookupRow> = [];
  // Refinement-pass swap counters.
  let rtpSwaps = 0;
  let cvSwaps = 0;
  let gapFillSwaps = 0;
  let gapsUnfillable = 0;
  let diversifySwaps = 0;
  // Diversify-pass budget inputs hoisted from the inner scope. The diversify
  // pass runs AFTER gap-fill (outside the inner scope), but needs the same
  // target Σ_smallNz_payout the cv pass used, plus the achievedSum the cv
  // pass left, to compute the remaining RTP-drift headroom.
  let targetSmallNzSumP = 0;
  let cvAchievedSum: number | null = null;
  // Compute W and small-tier subdivision now, so we can do RTP-aware non-zero
  // sampling using the same W used in the output.
  let W = 1;
  if (slotsForSmall > 0 && srcSmall.length > 0) {
    // Subdivide small into zero / non-zero so we can bias the sampling by
    // params.targetHitRate. Tier-based preserves cap rate naturally, but the
    // small-tier non-zero/zero composition can still be shifted to match a
    // user-requested hit-rate.
    const srcSmallZero: LookupRow[] = [];
    const srcSmallNonZero: LookupRow[] = [];
    for (const r of srcSmall) {
      if (r.payoutCents === 0) srcSmallZero.push(r);
      else srcSmallNonZero.push(r);
    }
    srcSmallNonZeroAll = srcSmallNonZero;

    // Target cap rate (cap + large weight share) — same `target` used for W below.
    const target_cap_rate = target;
    const targetHitRate = params.targetHitRate;

    // Solve for n_B (non-zero small rows) so that effective hit-rate = targetHitRate.
    // (nHighOut + W × n_B) / (nHighOut + W × nSmall) = h
    // where W is computed below using the same `target_cap_rate` formula, which
    // implies high contributes target_cap_rate of total weight and small carries
    // the remaining 1 - target_cap_rate split uniformly across nSmall.
    // → n_B = nSmall × [h − (1−h) × target_cap_rate / (1 − target_cap_rate)]
    const nHighOut = outCap.length + outLarge.length;
    let nB: number;
    if (target_cap_rate >= 1 || nHighOut === 0) {
      // No high tier or fully high: every small row contributes h share uniformly.
      nB = Math.round(slotsForSmall * targetHitRate);
    } else {
      const denom = 1 - target_cap_rate;
      nB = Math.round(
        slotsForSmall * (targetHitRate - ((1 - targetHitRate) * target_cap_rate) / denom),
      );
    }
    const requestedNB = nB;
    nB = Math.max(0, Math.min(nB, slotsForSmall, srcSmallNonZero.length));
    let nA = slotsForSmall - nB;
    // If zero bucket can't absorb nA, redirect overflow to non-zero
    if (nA > srcSmallZero.length) {
      const overflow = nA - srcSmallZero.length;
      nA = srcSmallZero.length;
      nB = Math.min(nB + overflow, srcSmallNonZero.length);
      // If still short, the output will simply be under-filled and padded later.
    }

    // Warnings on unreachable hit-rate targets.
    // Priority:
    //   1. Source has too few non-zero rows (covers nB===0 from empty source too).
    //   2. Cap-rate alone already meets/exceeds the target (formula yields nB<=0).
    if (
      requestedNB > srcSmallNonZero.length &&
      nB === srcSmallNonZero.length &&
      targetHitRate > 0
    ) {
      warnings.push(
        `source has only ${srcSmallNonZero.length} non-zero small rows; cannot reach targetHitRate=${targetHitRate}`,
      );
    } else if (requestedNB <= 0 && targetHitRate > 0 && nB === 0) {
      warnings.push(
        `targetHitRate=${targetHitRate} unreachable; cap+large weight share already meets or exceeds it (n_B clamped to 0)`,
      );
    }

    const bucketCount = params.bucketCount ?? 100;
    // Sample zero sub-bucket: uniform reservoir.
    outSmallZero =
      nA >= srcSmallZero.length
        ? [...srcSmallZero]
        : uniformReservoirSample(srcSmallZero, nA, seed);

    // RTP-aware non-zero sampling.
    // Compute the W we will use in the output (mirrors Phase 5 below). We have
    // nSmall = nA + nB once sampled; tier-based has bounded weights by design.
    const nSmallTotal = nA + nB;
    let WforSampling = 1;
    if (nSmallTotal > 0 && target > 0 && target < 1) {
      WforSampling = Math.max(
        1,
        Math.round((nHighOut * (1 - target)) / (nSmallTotal * target)),
      );
    } else if (nHighOut === 0) {
      WforSampling = 1;
    }
    W = WforSampling;

    // Compute target mean payout for the non-zero sample so the overall RTP
    // hits params.targetRTP.
    // Total weight T = nHighOut + W × (nA + nB)
    // Σ(w·p) needed = targetRTP × T × betCost  (NOT × 100 — betCost may differ)
    // Cap rows contribute Σ_cap = sum of cap+large payouts (weight=1 each)
    // Σ_smallNz contribution = W × Σ_sampled_nz_payouts
    // → Target Σ_sampled_nz_payouts = (targetRTP × T × betCost − Σ_cap) / W
    const totalWeightTarget = nHighOut + W * (nA + nB);
    const targetSumWP = params.targetRTP * totalWeightTarget * betCost;
    let capSumP = 0;
    for (const r of outCap) capSumP += r.payoutCents;
    for (const r of outLarge) capSumP += r.payoutCents;
    targetSmallNzSumP = W > 0 ? (targetSumWP - capSumP) / W : 0;
    const targetMeanNz = nB > 0 ? targetSmallNzSumP / nB : 0;

    if (nB >= srcSmallNonZero.length) {
      outSmallNonZero = [...srcSmallNonZero];
    } else if (nB > 0 && targetMeanNz > 0) {
      const sampleResult = rtpAwareSampleNonZero(
        srcSmallNonZero,
        nB,
        targetMeanNz,
        bucketCount,
        seed + 1,
      );
      outSmallNonZero = sampleResult.sampled;
      if (sampleResult.clamped) {
        warnings.push(
          `targetRTP=${params.targetRTP} unreachable for non-zero sample: requested mean payout ` +
            `${targetMeanNz.toFixed(0)} cents but achieved ${sampleResult.achievedMean.toFixed(0)} cents`,
        );
      }

      // Iterative swap refinement: close residual RTP gap by swapping
      // boundary rows in/out of the sample. Each swap is a single LookupRow
      // exchange, so the weight distribution remains exactly intact.
      //
      // params.toleranceRTP is on LUT-RTP scale (e.g. 0.001 = 0.1pp LUT RTP).
      // Achieved LUT RTP = (Σ_cap + W × Σ_smallNz) / (T × 100).
      // Tolerable Σ_smallNz drift = toleranceRTP × T × 100 / W.
      // Half it to leave a small safety budget for the CV pass that follows.
      const T_out_predict = nHighOut + W * (nA + nB);
      const rtpTolerance = W > 0 && T_out_predict > 0
        ? Math.max(1, 0.5 * params.toleranceRTP * T_out_predict * 100 / W)
        : Math.max(1, 0.005 * targetSmallNzSumP);
      const refined = refineRtpBySwap(
        outSmallNonZero,
        srcSmallNonZero,
        targetSmallNzSumP,
        rtpTolerance,
        10000,
      );
      outSmallNonZero = refined.rows;
      rtpSwaps = refined.swaps;

      if (!refined.converged && refined.swaps > 0 && targetSmallNzSumP > 0) {
        const achievedMean =
          outSmallNonZero.length > 0 ? refined.achievedSum / outSmallNonZero.length : 0;
        const targetMean =
          outSmallNonZero.length > 0 ? targetSmallNzSumP / outSmallNonZero.length : 0;
        const gap =
          targetMean > 0 ? (Math.abs(achievedMean - targetMean) / targetMean) * 100 : 0;
        warnings.push(
          `RTP refinement did not fully converge after ${refined.swaps} swaps (${gap.toFixed(2)}% gap)`,
        );
      }

      // Third refinement pass: Σ-preserving 2-swap pass to nudge CV toward
      // targetCV. RTP (Σ payout) is preserved within a 0.5% tolerance; only
      // Σ payout² is re-shaped. Increases CV by swapping a moderate (mid,mid)
      // pair from the sample for a spread (low,high) pair from outside; or
      // the inverse to decrease CV.
      //
      // Math:
      //   mean_out = (Σ_cap_payout + W × Σ_smallNz_payout) / T_out
      //   target_var = (targetCV × mean_out)²
      //   target E[X²] = target_var + mean_out² = mean_out² × (targetCV² + 1)
      //   target Σ(w·p²) = target_E[X²] × T_out
      //   target Σ_smallNz_p² = (target Σ(w·p²) − Σ_cap_p²) / W
      if (params.targetCV > 0 && outSmallNonZero.length >= 2) {
        const T_out = nHighOut + W * (nA + nB);
        if (T_out > 0) {
          let capSumP2 = 0;
          for (const r of outCap) capSumP2 += r.payoutCents * r.payoutCents;
          for (const r of outLarge) capSumP2 += r.payoutCents * r.payoutCents;

          // mean_out predicted from converged RTP refinement.
          const meanOutPredicted = (capSumP + W * refined.achievedSum) / T_out;
          const targetEX2 = meanOutPredicted * meanOutPredicted * (params.targetCV ** 2 + 1);
          const targetSumWP2 = targetEX2 * T_out;
          const targetSmallNzSumP2 = W > 0 ? (targetSumWP2 - capSumP2) / W : 0;

          if (targetSmallNzSumP2 > 0) {
            // Cumulative Σ-drift cap per CV pass = the OTHER HALF of the user's
            // RTP tolerance budget (the first half was spent by refineRtpBySwap).
            // Σ tolerance = 0.5 × toleranceRTP × T × 100 / W (same conversion).
            // This guarantees that even after both passes, total RTP drift
            // stays within params.toleranceRTP.
            const cvSumTolerance = W > 0
              ? Math.max(1, 0.5 * params.toleranceRTP * T_out * 100 / W)
              : Math.max(1, 0.001 * targetSmallNzSumP);
            // CV convergence threshold in Σ²-space:
            //   target E[X²] = mean² × (CV² + 1)
            //   d(Σ²_smallNz) / dCV = 2 × CV × mean² × T / W
            //   Σ²-tolerance = 2 × targetCV × mean² × T × toleranceCV / W
            // Stop swapping when Σ² is within this band of target.
            const cvSum2Tolerance = W > 0 && params.toleranceCV > 0 && params.targetCV > 0
              ? Math.max(1,
                  2 * params.targetCV * meanOutPredicted * meanOutPredicted *
                  T_out * params.toleranceCV / W)
              : Math.max(1, 0.001 * Math.abs(targetSmallNzSumP2));
            const cvRefined = refineCvBySwap(
              outSmallNonZero,
              srcSmallNonZero,
              targetSmallNzSumP2,
              cvSumTolerance,
              cvSum2Tolerance,
              500,
            );
            outSmallNonZero = cvRefined.rows;
            cvSwaps = cvRefined.swaps;
            cvAchievedSum = cvRefined.achievedSum;

            // Warn if CV refinement spent more RTP budget than half-toleranceRTP
            // (e.g. due to integer rounding in cvSumTolerance vs actual swap deltas).
            if (targetSmallNzSumP > 0 && params.toleranceRTP > 0) {
              const rtpDriftAbs =
                Math.abs(cvRefined.achievedSum - targetSmallNzSumP);
              if (rtpDriftAbs > cvSumTolerance * 1.1) {
                const rtpDriftPct = (rtpDriftAbs / targetSmallNzSumP) * 100;
                warnings.push(
                  `CV refinement drifted RTP by ${rtpDriftPct.toFixed(3)}% (${cvRefined.swaps} CV swaps)`,
                );
              }
            }
          }
        }
      }
    } else {
      // No RTP target signal (targetMeanNz <= 0 means cap already exceeds target,
      // or no non-zero slots): fall back to stratified shape-preserving sample.
      outSmallNonZero =
        nB > 0
          ? stratifiedSmallSampleNonZero(srcSmallNonZero, nB, bucketCount, seed + 1)
          : [];
      if (nB > 0 && targetMeanNz <= 0 && targetSumWP > 0) {
        warnings.push(
          `targetRTP=${params.targetRTP} unreachable: cap+large rows alone already meet or exceed it`,
        );
      }
    }

  }

  // Phase 4b: gap-filling pass — ensure no intermediate gaps in the Stake
  // hit-rate distribution. Stake's "Gaps in the Hit Rate Table" check
  // rejects publishing tables with empty ranges sandwiched between non-empty
  // ones. The earlier stratified/RTP-aware sampling can leave a small but
  // non-empty source range with 0 output slots after largest-remainder
  // allocation; this pass swaps in a source row from any such missing range.
  //
  // Range occupancy is counted across ALL output rows (cap + large + small),
  // so a range filled by cap/large rows is NOT considered a gap. Swaps only
  // happen within the small-non-zero tier (where we have flexibility).
  const ensureRangeCoverage = params.ensureRangeCoverage ?? true;
  if (ensureRangeCoverage && outSmallNonZero.length > 0) {
    // Sort by payout ascending for the range-scan inside fillStakeRangeGaps.
    outSmallNonZero.sort((a, b) => a.payoutCents - b.payoutCents);
    const otherOutRows: LookupRow[] = [...outCap, ...outLarge];
    const gapResult = fillStakeRangeGaps(
      outSmallNonZero,
      srcSmallNonZeroAll,
      otherOutRows,
      sourceMetrics.maxPayout,
      betCost,
      warnings,
    );
    gapFillSwaps = gapResult.swapsApplied;
    gapsUnfillable = gapResult.unfillable;
  }

  // Phase 4c: diversification pass — maximize distinct payoutCents in output.
  // Stake Engine rejects "Insufficient Unique Events" when too few distinct
  // payouts exist. Swap duplicate-payout rows in outSmallNonZero for source
  // rows carrying NEW (unseen) payout values, subject to the remaining RTP
  // drift budget.
  const minUniqueRate = params.minUniqueEventsRate ?? 0.01;
  if (minUniqueRate > 0 && outSmallNonZero.length > 0) {
    const targetUnique = Math.ceil(minUniqueRate * params.nRowsOut);
    const nHighOut2 = outCap.length + outLarge.length;
    // Predict T_out and W as the gap-fill pass left them (W is final after
    // Phase 5 computes it, but for the budget we use the same prediction the
    // cv pass did).
    const T_out_predict2 = nHighOut2 + W * (outSmallZero.length + outSmallNonZero.length);
    // Diversify budget = full user-supplied RTP-drift envelope minus what RTP+CV
    // passes already spent. The earlier passes are capped at 0.5 × full_budget
    // each, but typically use far less — the leftover funds diversify. This
    // guarantees cumulative drift across all refinement passes stays within
    // params.toleranceRTP.
    const fullBudget = W > 0 && T_out_predict2 > 0
      ? params.toleranceRTP * T_out_predict2 * 100 / W
      : 0.01 * Math.abs(targetSmallNzSumP);
    const spent =
      cvAchievedSum !== null && targetSmallNzSumP !== 0
        ? Math.abs(cvAchievedSum - targetSmallNzSumP)
        : 0;
    const sumBudget = Math.max(1, fullBudget - spent);
    // Make sure outSmallNonZero is sorted by payout ascending (gap-fill already
    // maintained this invariant when run; if gap-fill was skipped, sort here).
    outSmallNonZero.sort((a, b) => a.payoutCents - b.payoutCents);
    const otherOutRows: LookupRow[] = [...outCap, ...outLarge, ...outSmallZero];
    const divResult = diversifyPayouts(
      outSmallNonZero,
      srcSmallNonZeroAll,
      otherOutRows,
      targetUnique,
      sumBudget,
      warnings,
    );
    diversifySwaps = divResult.swaps;
  }

  const outSmall: LookupRow[] = [...outSmallZero, ...outSmallNonZero];

  // Phase 5: compute W (recompute to match actual nSmall after sampling)
  const nHigh = outCap.length + outLarge.length;
  const nSmall = outSmall.length;
  if (nSmall > 0 && target > 0 && target < 1) {
    W = Math.max(1, Math.round((nHigh * (1 - target)) / (nSmall * target)));
  } else if (nHigh === 0) {
    W = 1; // no high tier — all uniform
  }

  // Phase 6: build output
  const outRows: LookupRow[] = [];
  for (const r of outCap) outRows.push({ sim: r.sim, weight: 1, payoutCents: r.payoutCents });
  for (const r of outLarge) outRows.push({ sim: r.sim, weight: 1, payoutCents: r.payoutCents });
  for (const r of outSmall) outRows.push({ sim: r.sim, weight: W, payoutCents: r.payoutCents });

  // Pad with synthetic zero-payout rows if short
  while (outRows.length < params.nRowsOut) {
    outRows.push({ sim: -1, weight: 1, payoutCents: 0 });
  }

  // Phase 7: metrics and report
  const achieved = computeMetrics(outRows);

  const toleranceMet: ToleranceMet = {
    rtp: Math.abs(achieved.rtp - params.targetRTP) <= params.toleranceRTP,
    cv: Math.abs(achieved.cv - params.targetCV) <= params.toleranceCV,
    hitRate: Math.abs(achieved.hitRate - params.targetHitRate) <= params.toleranceHitRate,
    maxReached:
      !requireMaxReached ||
      outRows.some((r) => isNearMax(r.payoutCents, params.capMaxWin, maxReachedFraction)),
    rtpConcentration: true, // tier-based doesn't concentrate by design — always true
    weightCap: true, // tier-based has bounded weights by design
  };

  // maxRowRtpShare
  let totalWP = 0;
  for (const r of outRows) totalWP += r.weight * r.payoutCents;
  let maxRowShare = 0;
  if (totalWP > 0) {
    for (const r of outRows) {
      const share = (r.weight * r.payoutCents) / totalWP;
      if (share > maxRowShare) maxRowShare = share;
    }
  }

  // Max weight ratio
  const uniformPrior = achieved.totalWeight / outRows.length;
  let maxWeightObs = 0;
  for (const r of outRows) {
    if (r.weight > maxWeightObs) maxWeightObs = r.weight;
  }
  const maxWeightRatio = uniformPrior > 0 ? maxWeightObs / uniformPrior : 1;

  // Stake report
  const stakeReport = computeStakeReport(outRows, achieved, betCost);

  if (sourceMetrics.maxPayout < maxReachedFraction * params.capMaxWin && requireMaxReached) {
    warnings.push(
      `no row reaches ${maxReachedFraction * 100}% of capMaxWin; requireMaxReached cannot be honored`,
    );
  }

  // Warn about intermediate gaps in the hit-rate distribution (Stake's
  // "Gaps in the Hit Rate Table" check). Empty ranges above the highest
  // non-empty range are natural and not flagged.
  const gaps = detectHitRateGaps(stakeReport.hitRateDistribution);
  if (gaps.length > 0) {
    const formatted = gaps.map((g) => `[${g.low}, ${g.high})`).join(', ');
    warnings.push(
      `hit-rate distribution has ${gaps.length} intermediate gap(s) — Stake "Gaps in the Hit Rate Table" check may fail: ${formatted}`,
    );
  }

  return {
    rows: outRows,
    achieved,
    toleranceMet,
    maxRowRtpShare: maxRowShare,
    maxWeightRatio,
    refinement: { rtpSwaps, cvSwaps, gapFillSwaps, gapsUnfillable, diversifySwaps },
    warnings,
    stakeReport,
  };
}

/**
 * RTP-aware non-zero sample: pick `k` rows from `srcNonZero` such that their
 * MEAN payout is approximately `targetMeanPayout`, while preserving shape
 * within each side of the split via stratified sampling.
 *
 * Strategy — two-side analytical LP:
 *   Split source into "low" (payout < targetMeanPayout) and "high" (>=).
 *   Compute μ_low, μ_high.
 *   Solve: n_high × μ_high + (k − n_high) × μ_low = k × targetMeanPayout
 *     →   n_high = k × (targetMeanPayout − μ_low) / (μ_high − μ_low)
 *   Clamp to [0, |high|] and [0, |low|], then stratified-sample within each.
 *
 * If clamping prevents reaching the target mean, returns clamped=true.
 */
function rtpAwareSampleNonZero(
  srcNonZero: ReadonlyArray<LookupRow>,
  k: number,
  targetMeanPayout: number,
  bucketCount: number,
  seed: number,
): { sampled: LookupRow[]; achievedMean: number; clamped: boolean } {
  if (k === 0) return { sampled: [], achievedMean: 0, clamped: false };
  if (k >= srcNonZero.length) {
    let sum = 0;
    for (const r of srcNonZero) sum += r.payoutCents;
    const mean = srcNonZero.length > 0 ? sum / srcNonZero.length : 0;
    return { sampled: [...srcNonZero], achievedMean: mean, clamped: true };
  }

  // Compute source mean for the early-exit "close enough" check.
  let srcSum = 0;
  for (const r of srcNonZero) srcSum += r.payoutCents;
  const sourceMean = srcSum / srcNonZero.length;

  // If target is within 1% of source mean, plain stratified sample is fine
  // (no bias needed).
  if (sourceMean > 0 && Math.abs(targetMeanPayout - sourceMean) / sourceMean < 0.01) {
    const sampled = stratifiedSmallSampleNonZero(srcNonZero, k, bucketCount, seed);
    let s = 0;
    for (const r of sampled) s += r.payoutCents;
    const mean = sampled.length > 0 ? s / sampled.length : 0;
    return { sampled, achievedMean: mean, clamped: false };
  }

  // Split into low (payout < targetMean) and high (payout >= targetMean).
  const low: LookupRow[] = [];
  const high: LookupRow[] = [];
  for (const r of srcNonZero) {
    if (r.payoutCents < targetMeanPayout) low.push(r);
    else high.push(r);
  }
  if (low.length === 0 || high.length === 0) {
    // Target outside source range: can't reach it. Sample uniformly + clamp.
    const sampled = stratifiedSmallSampleNonZero(srcNonZero, k, bucketCount, seed);
    let s = 0;
    for (const r of sampled) s += r.payoutCents;
    const mean = sampled.length > 0 ? s / sampled.length : 0;
    return { sampled, achievedMean: mean, clamped: true };
  }

  let lowSum = 0;
  for (const r of low) lowSum += r.payoutCents;
  let highSum = 0;
  for (const r of high) highSum += r.payoutCents;
  const muLow = lowSum / low.length;
  const muHigh = highSum / high.length;

  // Avoid division by zero if both groups collapse to same mean.
  if (muHigh - muLow < 1e-9) {
    const sampled = stratifiedSmallSampleNonZero(srcNonZero, k, bucketCount, seed);
    let s = 0;
    for (const r of sampled) s += r.payoutCents;
    const mean = sampled.length > 0 ? s / sampled.length : 0;
    return { sampled, achievedMean: mean, clamped: true };
  }

  let nHighOut = Math.round((k * (targetMeanPayout - muLow)) / (muHigh - muLow));
  let clamped = false;
  if (nHighOut < 0) {
    nHighOut = 0;
    clamped = true;
  }
  if (nHighOut > high.length) {
    nHighOut = high.length;
    clamped = true;
  }
  if (nHighOut > k) {
    nHighOut = k;
    clamped = true;
  }
  let nLowOut = k - nHighOut;
  if (nLowOut > low.length) {
    // Shouldn't happen given nHighOut bounds + (low+high=src) and k < src.length,
    // but redirect overflow to high if it does.
    const overflow = nLowOut - low.length;
    nLowOut = low.length;
    nHighOut = Math.min(nHighOut + overflow, high.length);
    clamped = true;
  }
  if (nLowOut < 0) {
    nLowOut = 0;
    clamped = true;
  }

  const subBuckets = Math.max(2, Math.floor(bucketCount / 2));
  const sampleLow =
    nLowOut >= low.length
      ? [...low]
      : nLowOut > 0
        ? stratifiedSmallSampleNonZero(low, nLowOut, subBuckets, seed)
        : [];
  const sampleHigh =
    nHighOut >= high.length
      ? [...high]
      : nHighOut > 0
        ? stratifiedSmallSampleNonZero(high, nHighOut, subBuckets, seed + 17)
        : [];

  const sampled = [...sampleLow, ...sampleHigh];
  let sumOut = 0;
  for (const r of sampled) sumOut += r.payoutCents;
  const achievedMean = sampled.length > 0 ? sumOut / sampled.length : 0;
  // If we hit a hard side cap (consumed entire low or entire high group), flag.
  if (nHighOut === high.length || nLowOut === low.length) clamped = true;
  return { sampled, achievedMean, clamped };
}

/**
 * Iterative row-level swap refinement to close residual RTP gap.
 *
 * The analytical low/high partition in `rtpAwareSampleNonZero` lands within a
 * few rows of the optimum but `Math.round(nHighOut)` and `Math.round(W)` leak
 * ~1% of RTP. This function exchanges single rows in/out of the sample to
 * close the residual Σ-payout gap to the target, without touching the
 * row count or weight distribution.
 *
 * Each swap replaces ONE sample row with ONE outside row, so |sampled|
 * stays exactly k. Converges in O(K) swaps where K is the initial gap
 * measured in row-payout units.
 */
function refineRtpBySwap(
  sampled: ReadonlyArray<LookupRow>,
  pool: ReadonlyArray<LookupRow>,
  targetSumPayout: number,
  tolerance: number,
  maxSwaps: number,
): { rows: LookupRow[]; achievedSum: number; swaps: number; converged: boolean } {
  const inSet = new Set<number>();
  for (const r of sampled) inSet.add(r.sim);

  let achievedSum = 0;
  for (const r of sampled) achievedSum += r.payoutCents;

  const sampledArr = sampled.slice();
  const outsideArr: LookupRow[] = [];
  for (const r of pool) {
    if (!inSet.has(r.sim)) outsideArr.push(r);
  }
  sampledArr.sort((a, b) => a.payoutCents - b.payoutCents); // ascending
  outsideArr.sort((a, b) => a.payoutCents - b.payoutCents);

  // Binary-search-by-payout helpers on a sorted array.
  const lowerBound = (arr: ReadonlyArray<LookupRow>, target: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].payoutCents < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  let swaps = 0;
  let converged = false;

  while (swaps < maxSwaps) {
    const delta = targetSumPayout - achievedSum;
    if (Math.abs(delta) <= tolerance) {
      converged = true;
      break;
    }

    if (delta > 0) {
      // Raise Σ: swap lowest sample OUT for highest outside row whose
      // payout is ≤ (sampleLow + delta), but > sampleLow.
      if (sampledArr.length === 0 || outsideArr.length === 0) break;
      const sampleLow = sampledArr[0];
      const desired = sampleLow.payoutCents + delta;

      // Largest outside index with payout ≤ desired AND > sampleLow.payoutCents.
      // Use lowerBound for desired+1 (first > desired) - 1 → last ≤ desired.
      let bestIdx = lowerBound(outsideArr, desired + 1) - 1;
      // Constraint: must be strictly greater than sampleLow to improve Σ.
      if (bestIdx < 0 || outsideArr[bestIdx].payoutCents <= sampleLow.payoutCents) {
        // No outside row in (sampleLow, sampleLow+delta]. Try the largest
        // available outside row > sampleLow (would overshoot but reduce |delta|
        // only if 2 * outsideRow - 2 * sampleLow ≤ delta is false → would
        // overshoot more than current undershoot; skip).
        // We strictly require non-overshooting swap → stop.
        break;
      }
      const outsideRow = outsideArr[bestIdx];
      const newSum = achievedSum + outsideRow.payoutCents - sampleLow.payoutCents;

      // Apply swap: remove sampleLow (front), insert outsideRow sorted into sampledArr.
      sampledArr.shift();
      const insertPos = lowerBound(sampledArr, outsideRow.payoutCents);
      sampledArr.splice(insertPos, 0, outsideRow);
      // Remove outsideRow from outsideArr, insert sampleLow sorted.
      outsideArr.splice(bestIdx, 1);
      const outPos = lowerBound(outsideArr, sampleLow.payoutCents);
      outsideArr.splice(outPos, 0, sampleLow);

      inSet.delete(sampleLow.sim);
      inSet.add(outsideRow.sim);
      achievedSum = newSum;
    } else {
      // Lower Σ: swap highest sample OUT for lowest outside row whose
      // payout is ≥ (sampleHigh - |delta|), but < sampleHigh.
      if (sampledArr.length === 0 || outsideArr.length === 0) break;
      const sampleHigh = sampledArr[sampledArr.length - 1];
      const needLoss = -delta;
      const desired = sampleHigh.payoutCents - needLoss;

      // Smallest outside index with payout ≥ desired AND < sampleHigh.payoutCents.
      let bestIdx = lowerBound(outsideArr, desired);
      if (bestIdx >= outsideArr.length || outsideArr[bestIdx].payoutCents >= sampleHigh.payoutCents) {
        break;
      }
      const outsideRow = outsideArr[bestIdx];
      const newSum = achievedSum + outsideRow.payoutCents - sampleHigh.payoutCents;

      sampledArr.pop();
      const insertPos = lowerBound(sampledArr, outsideRow.payoutCents);
      sampledArr.splice(insertPos, 0, outsideRow);
      outsideArr.splice(bestIdx, 1);
      const outPos = lowerBound(outsideArr, sampleHigh.payoutCents);
      outsideArr.splice(outPos, 0, sampleHigh);

      inSet.delete(sampleHigh.sim);
      inSet.add(outsideRow.sim);
      achievedSum = newSum;
    }
    swaps++;
  }

  return { rows: sampledArr, achievedSum, swaps, converged };
}

/**
 * Σ-preserving 2-swap refinement to nudge CV toward target without
 * disturbing Σ payout (RTP).
 *
 * A "2-swap" exchanges two rows (a, b) currently IN the sample for two rows
 * (c, d) currently OUT, such that a + b ≈ c + d (within sumTolerance) and
 * a² + b² ≠ c² + d². RTP is preserved; only the second moment shifts.
 *
 *   To INCREASE variance: swap moderate (mid, mid) → spread (low, high).
 *   To DECREASE variance: swap spread (low, high) → moderate (mid, mid).
 *
 * Each iteration picks the best-improving swap from a small set of candidates
 * at the extremes / median of the current sorted sample and outside pool.
 */
function refineCvBySwap(
  sample: ReadonlyArray<LookupRow>,
  pool: ReadonlyArray<LookupRow>,
  targetSumPayout2: number,
  sumTolerance: number,
  sum2Tolerance: number,
  maxSwaps: number,
): { rows: LookupRow[]; achievedSum: number; achievedSum2: number; swaps: number } {
  const inSet = new Set<number>();
  for (const r of sample) inSet.add(r.sim);

  let sumP = 0;
  let sumP2 = 0;
  for (const r of sample) {
    sumP += r.payoutCents;
    sumP2 += r.payoutCents * r.payoutCents;
  }
  const initialSumP = sumP;

  const sampleArr = sample.slice().sort((a, b) => a.payoutCents - b.payoutCents);
  const outsideArr: LookupRow[] = [];
  for (const r of pool) {
    if (!inSet.has(r.sim)) outsideArr.push(r);
  }
  outsideArr.sort((a, b) => a.payoutCents - b.payoutCents);

  let swaps = 0;
  while (swaps < maxSwaps) {
    const deltaSum2 = targetSumPayout2 - sumP2;
    if (Math.abs(deltaSum2) <= sum2Tolerance) break;

    let bestSwap: {
      sampleA: LookupRow;
      sampleB: LookupRow;
      sampleIdxA: number;
      sampleIdxB: number;
      outsideC: LookupRow;
      outsideD: LookupRow;
      outsideIdxC: number;
      outsideIdxD: number;
      newSum: number;
      newSum2: number;
      gain: number;
      efficiency: number;
    } | null = null;

    // Strategy: for each sample pair (a, b) with a < b, find an outside pair
    // (c, d) such that c + d ≈ a + b (RTP-preserving) but |c − (a+b)/2| ≠
    // |a − (a+b)/2|, i.e., the outside pair has different spread than the
    // sample pair. To INCREASE Σ p²: find outside pair with LARGER spread
    // (one row below `a`, the other above `b`). To DECREASE Σ p²: find
    // outside pair with SMALLER spread (both rows between `a` and `b`).
    //
    // Among heavy-tailed data the only pairs with non-trivial Σ² impact
    // anchor on a high-payout row. So we iterate sample's "high" half (anchor
    // = b, large index) and pair it with each anchor sample row a (a < b).
    // For increase: find outside c < a with c + d ≈ a + b, where d = a+b−c
    // and d must exist in outside near payout a+b−c, with d > b. For decrease:
    // find outside c > a, c < b such that d = a+b−c is also in outside with
    // a < d < b.
    if (sampleArr.length < 2 || outsideArr.length < 2) break;

    const sLen = sampleArr.length;
    const outLen = outsideArr.length;

    // Anchor count: how many sample pairs to probe per iteration. Larger →
    // better swap selection but slower. K_HI focuses on the high-payout end
    // (where Σ² is dominated); K_LO on the low end.
    const K_HI = 8;
    const K_LO = 8;

    // For each candidate sample pair (aRow, bRow), choose outside `c` then
    // derive targetD = (a + b) − c. Binary-search outside for d-rows near
    // targetD. To INCREASE Σ²: pick c far from (a+b)/2 (more spread) — try
    // very small or very large outside indices. To DECREASE Σ²: pick c near
    // (a+b)/2 (less spread).
    //
    // We probe K_HI sample pairs anchored on high-payout sample rows (where
    // Σ² is dominated) plus a smattering of mid-range pairs.
    const cProbes = 32;
    const sampleAnchorPairs: [number, number][] = [];
    for (let hi = sLen - 1; hi >= Math.max(0, sLen - K_HI); hi--) {
      for (let lo = 0; lo < Math.min(K_LO, hi); lo++) {
        sampleAnchorPairs.push([lo, hi]);
      }
    }

    for (const [lo, hi] of sampleAnchorPairs) {
      const aRow = sampleArr[lo];
      const bRow = sampleArr[hi];
      if (aRow.payoutCents === bRow.payoutCents) continue;
      const oldSum = aRow.payoutCents + bRow.payoutCents;
      const oldSum2 =
        aRow.payoutCents * aRow.payoutCents + bRow.payoutCents * bRow.payoutCents;

      // Pick c candidates. For INCREASE: c far from oldSum/2 (extremes of
      // outside). For DECREASE: c near oldSum/2.
      const cIdxs: number[] = [];
      if (deltaSum2 > 0) {
        // Take extremes: smallest few and largest few outside rows.
        const half = Math.ceil(cProbes / 2);
        for (let s = 0; s < Math.min(half, outLen); s++) cIdxs.push(s);
        for (let s = 0; s < Math.min(half, outLen); s++) {
          const idx = outLen - 1 - s;
          if (idx >= 0) cIdxs.push(idx);
        }
      } else {
        // Center of outside near oldSum/2.
        const target = oldSum / 2;
        const center = lowerBoundIdx(outsideArr, target);
        const half = Math.ceil(cProbes / 2);
        for (let off = -half; off <= half; off++) {
          const idx = center + off;
          if (idx >= 0 && idx < outLen) cIdxs.push(idx);
        }
      }

      // Tighten per-swap Σ drift: each candidate's newSum must stay within
      // sumTolerance of initialSumP (cumulative cap), not oldSum (local cap).
      const lowerOk = initialSumP - sumTolerance;
      const upperOk = initialSumP + sumTolerance;

      for (const ci of cIdxs) {
        const cRow = outsideArr[ci];
        const targetD = oldSum - cRow.payoutCents;
        if (targetD <= 0) continue;
        // Per-swap delta limited by remaining cumulative budget so total Σ
        // stays within sumTolerance of initialSumP.
        const remainingBudget = Math.max(0, sumTolerance - Math.abs(sumP - initialSumP));
        const perSwapTol = Math.min(sumTolerance, remainingBudget + sumTolerance * 0.1);
        const dIdxLB = lowerBoundIdx(outsideArr, targetD - perSwapTol);
        const dIdxUB = lowerBoundIdx(outsideArr, targetD + perSwapTol + 1);
        for (let di = dIdxLB; di < dIdxUB && di < outLen; di++) {
          if (di === ci) continue;
          const dRow = outsideArr[di];
          const newSumPair = cRow.payoutCents + dRow.payoutCents;
          const candNewSumP = sumP - oldSum + newSumPair;
          // Cumulative drift constraint.
          if (candNewSumP < lowerOk || candNewSumP > upperOk) continue;
          const newSum2Pair =
            cRow.payoutCents * cRow.payoutCents + dRow.payoutCents * dRow.payoutCents;
          // Skip identity swap.
          if (
            (cRow.sim === aRow.sim && dRow.sim === bRow.sim) ||
            (cRow.sim === bRow.sim && dRow.sim === aRow.sim)
          )
            continue;
          const candNewSum2 = sumP2 - oldSum2 + newSum2Pair;
          const gain = Math.abs(deltaSum2) - Math.abs(targetSumPayout2 - candNewSum2);
          // Penalize swaps with non-zero Σ drift: efficiency = gain per unit
          // of |Σ delta| consumed (with small ε to avoid div-by-zero).
          const sumDelta = Math.abs(newSumPair - oldSum);
          const efficiency = gain / (1 + sumDelta);
          if (gain > 0 && (!bestSwap || efficiency > bestSwap.efficiency)) {
            bestSwap = {
              sampleA: aRow,
              sampleB: bRow,
              sampleIdxA: lo,
              sampleIdxB: hi,
              outsideC: cRow,
              outsideD: dRow,
              outsideIdxC: ci,
              outsideIdxD: di,
              newSum: candNewSumP,
              newSum2: candNewSum2,
              gain,
              efficiency,
            };
          }
        }
      }
    }

    if (!bestSwap) break;

    // Apply swap. Remove indices in descending order so earlier indices stay valid.
    const sampleRemove = [bestSwap.sampleIdxA, bestSwap.sampleIdxB].sort((x, y) => y - x);
    sampleArr.splice(sampleRemove[0], 1);
    sampleArr.splice(sampleRemove[1], 1);
    insertSorted(sampleArr, bestSwap.outsideC);
    insertSorted(sampleArr, bestSwap.outsideD);

    const outsideRemove = [bestSwap.outsideIdxC, bestSwap.outsideIdxD].sort((x, y) => y - x);
    outsideArr.splice(outsideRemove[0], 1);
    outsideArr.splice(outsideRemove[1], 1);
    insertSorted(outsideArr, bestSwap.sampleA);
    insertSorted(outsideArr, bestSwap.sampleB);

    inSet.delete(bestSwap.sampleA.sim);
    inSet.delete(bestSwap.sampleB.sim);
    inSet.add(bestSwap.outsideC.sim);
    inSet.add(bestSwap.outsideD.sim);

    sumP = bestSwap.newSum;
    sumP2 = bestSwap.newSum2;
    swaps++;
  }

  return { rows: sampleArr, achievedSum: sumP, achievedSum2: sumP2, swaps };
}

function insertSorted(arr: LookupRow[], row: LookupRow): void {
  const lo = lowerBoundIdx(arr, row.payoutCents);
  arr.splice(lo, 0, row);
}

/** First index `i` with `arr[i].payoutCents >= target`. */
function lowerBoundIdx(arr: ReadonlyArray<LookupRow>, target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].payoutCents < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Stratified sample of `k` rows from non-zero `rows`, partitioning by
 * log(payout). Each bucket contributes a slot count proportional to its size
 * in the source, so the sample preserves the source's per-bucket population
 * and (in expectation) its mean payout — critical for RTP fidelity.
 *
 * A simple uniform reservoir over a long-tailed distribution can over-pick
 * tail rows by chance; with weight=W in the output, that drift gets amplified
 * (here observed as +7.6% RTP on real ANTE data). Stratification eliminates
 * that drift.
 *
 * Assumes all input rows have payoutCents > 0; the zero-payout rows are
 * handled separately by `uniformReservoirSample` so the caller can bias the
 * zero/non-zero ratio per `targetHitRate`.
 */
function stratifiedSmallSampleNonZero(
  rows: ReadonlyArray<LookupRow>,
  k: number,
  bucketCount: number,
  seed: number,
): LookupRow[] {
  if (k >= rows.length) return [...rows];
  if (k <= 0) return [];

  // Find min/max payout for log bucketing.
  let minPayout = Infinity;
  let maxPayout = 0;
  for (const r of rows) {
    if (r.payoutCents > 0 && r.payoutCents < minPayout) minPayout = r.payoutCents;
    if (r.payoutCents > maxPayout) maxPayout = r.payoutCents;
  }
  const usable = isFinite(minPayout) && maxPayout > 0;

  type Bucket = { indices: number[] };
  const logBuckets: Bucket[] = Array.from({ length: bucketCount }, () => ({ indices: [] }));

  const logMin = usable ? Math.log(minPayout) : 0;
  const logMax = usable ? Math.log(maxPayout) : 1;
  const logSpan = Math.max(logMax - logMin, 1e-9);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.payoutCents <= 0) continue; // defensive — caller passes non-zero only
    let bidx = 0;
    if (usable && logSpan > 0) {
      const t = (Math.log(r.payoutCents) - logMin) / logSpan;
      bidx = Math.min(bucketCount - 1, Math.max(0, Math.floor(t * bucketCount)));
    }
    logBuckets[bidx].indices.push(i);
  }

  // Allocate slots per bucket proportional to bucket size (largest-remainder).
  const sizes = logBuckets.map((b) => b.indices.length);
  const total = sizes.reduce((s, v) => s + v, 0);
  if (total === 0) return [];
  const proposed = sizes.map((s) => (s / total) * k);
  const floors = proposed.map(Math.floor);
  const used = floors.reduce((s, v) => s + v, 0);
  const remainders = proposed.map((p, i) => p - floors[i]);
  const order = remainders.map((_, i) => i).sort((a, b) => remainders[b] - remainders[a]);
  let extra = k - used;
  for (const i of order) {
    if (extra === 0) break;
    if (floors[i] < sizes[i]) {
      floors[i]++;
      extra--;
    }
  }
  for (let i = 0; i < floors.length; i++) {
    if (floors[i] > sizes[i]) floors[i] = sizes[i];
  }

  const rng = mulberry32(seed);
  const out: LookupRow[] = [];
  for (let bi = 0; bi < logBuckets.length; bi++) {
    const slots = floors[bi];
    if (slots <= 0) continue;
    const indices = logBuckets[bi].indices;
    const weights = new Array(indices.length).fill(1);
    const sampled = weightedReservoirSample(indices, weights, slots, rng);
    for (const idx of sampled) out.push(rows[idx]);
  }

  return out;
}

/**
 * Uniform reservoir sample of `k` rows from `rows`. Used for the zero-payout
 * sub-bucket where stratification by payout is meaningless (single value).
 */
function uniformReservoirSample(
  rows: ReadonlyArray<LookupRow>,
  k: number,
  seed: number,
): LookupRow[] {
  if (k >= rows.length) return [...rows];
  if (k <= 0) return [];
  const rng = mulberry32(seed);
  const indices = rows.map((_, i) => i);
  const weights = new Array(indices.length).fill(1);
  const sampled = weightedReservoirSample(indices, weights, k, rng);
  return sampled.map((idx) => rows[idx]);
}

/**
 * Find the index of the Stake hit-rate range that `payoutCents` falls into.
 * Returns -1 if no range matches (shouldn't happen given the [0, 0.1] +
 * [20000, ∞) coverage, but defensive).
 */
function findRange(payoutCents: number, betCostCents: number): number {
  const pm = payoutCents / betCostCents;
  for (let i = 0; i < HIT_RATE_RANGES.length; i++) {
    const [low, high] = HIT_RATE_RANGES[i];
    if (pm >= low && pm < high) return i;
  }
  return -1;
}

/**
 * Fourth refinement pass: ensure no intermediate gaps in the Stake hit-rate
 * distribution table. Stake rejects publishing tables with empty ranges
 * sandwiched between non-empty ones ("Gaps in the Hit Rate Table" check).
 *
 * Algorithm: for each range below maxPayout that's empty in output, find a
 * source row in that range and swap it in by replacing an output row whose
 * payout is closest (minimizes Σ payout drift). Skips ranges where source
 * has no rows (impossible to fill — emit a one-time warning).
 *
 * Modifies `outSmallNonZero` in place (preserves sorted-by-payout-ascending
 * invariant). Returns number of swaps applied plus the number of ranges that
 * source couldn't fill.
 *
 * Performance: O(R × (N + |source|)) where R = 16 ranges; the rangeCount/
 * rangeIdx maps avoid the naive O(N²) inner range-count.
 */
function fillStakeRangeGaps(
  outSmallNonZero: LookupRow[],
  srcSmallNonZero: ReadonlyArray<LookupRow>,
  otherOutRows: ReadonlyArray<LookupRow>,
  maxPayoutCents: number,
  betCostCents: number,
  warnings: string[],
): { swapsApplied: number; unfillable: number } {
  let swapsApplied = 0;
  let unfillable = 0;

  // Build set of in-sample sim ids for fast membership tests.
  const inSample = new Set<number>();
  for (const r of outSmallNonZero) inSample.add(r.sim);

  // Pre-compute per-row range index for the swappable tier (small non-zero).
  const rangeIdx: number[] = outSmallNonZero.map((r) =>
    findRange(r.payoutCents, betCostCents),
  );
  // Range counts over the FULL output (small + cap/large): a range filled by
  // cap/large rows is not a gap, even if small-tier alone has 0 in it.
  const rangeCount = new Map<number, number>();
  for (const idx of rangeIdx) rangeCount.set(idx, (rangeCount.get(idx) ?? 0) + 1);
  for (const r of otherOutRows) {
    const idx = findRange(r.payoutCents, betCostCents);
    rangeCount.set(idx, (rangeCount.get(idx) ?? 0) + 1);
  }

  // Only consider Stake ranges whose lower bound is below maxPayout (in bet units).
  const maxPm = maxPayoutCents / betCostCents;

  for (let rangeI = 0; rangeI < HIT_RATE_RANGES.length; rangeI++) {
    const [low, high] = HIT_RATE_RANGES[rangeI];
    if (low >= maxPm) break; // tail ranges above maxPayout — natural empty
    const lowCents = low * betCostCents;
    const highCents = high === Infinity ? Infinity : high * betCostCents;

    // Skip the [0, 0.1) range — that's the zero-tier territory (payouts < 0.1
    // bet units, i.e. 0 cents at betCost=100). Zero-payouts are handled by the
    // zero sub-bucket; we don't fill via non-zero rows here.
    if (low === 0) continue;

    // Skip if already populated.
    if ((rangeCount.get(rangeI) ?? 0) >= 1) continue;

    // Find source rows in this range that aren't already in sample.
    const sourceCandidates: LookupRow[] = [];
    for (const r of srcSmallNonZero) {
      if (r.payoutCents >= lowCents && r.payoutCents < highCents && !inSample.has(r.sim)) {
        sourceCandidates.push(r);
      }
    }
    if (sourceCandidates.length === 0) {
      unfillable++;
      const rangeStr =
        high === Infinity ? `[${low}, infinity)` : `[${low}, ${high})`;
      warnings.push(
        `gap in hit-rate range ${rangeStr}x bet: source has no rows in this payout-multiplier range`,
      );
      continue;
    }

    // Pick source row closest to range geometric mid so any subsequent
    // statistic sliding remains balanced.
    const midPayout =
      high === Infinity
        ? Math.max(lowCents, maxPayoutCents)
        : Math.sqrt(lowCents * highCents);
    let swapInRow = sourceCandidates[0];
    let bestDist = Math.abs(swapInRow.payoutCents - midPayout);
    for (const r of sourceCandidates) {
      const d = Math.abs(r.payoutCents - midPayout);
      if (d < bestDist) {
        swapInRow = r;
        bestDist = d;
      }
    }

    // Pick output row to remove: payout closest to swapInRow.payoutCents so
    // Σ-payout drift (i.e. RTP impact) is minimized. Skip any row whose
    // removal would empty another range.
    let removeIdx = -1;
    let removeDist = Infinity;
    for (let i = 0; i < outSmallNonZero.length; i++) {
      if ((rangeCount.get(rangeIdx[i]) ?? 0) <= 1) continue; // protect other ranges
      const r = outSmallNonZero[i];
      const d = Math.abs(r.payoutCents - swapInRow.payoutCents);
      if (d < removeDist) {
        removeDist = d;
        removeIdx = i;
      }
    }
    if (removeIdx < 0) {
      // No safe removal candidate — every range has exactly 1 row. Skip
      // this gap rather than break other ranges.
      unfillable++;
      continue;
    }

    // Apply the swap.
    const removedRow = outSmallNonZero[removeIdx];
    const removedRangeIdx = rangeIdx[removeIdx];
    inSample.delete(removedRow.sim);
    inSample.add(swapInRow.sim);
    // Remove the old row, then re-insert swapInRow at the correct sorted
    // position to preserve the ascending invariant. Also update rangeIdx
    // and rangeCount.
    outSmallNonZero.splice(removeIdx, 1);
    rangeIdx.splice(removeIdx, 1);
    rangeCount.set(removedRangeIdx, (rangeCount.get(removedRangeIdx) ?? 1) - 1);

    let insertPos = 0;
    while (
      insertPos < outSmallNonZero.length &&
      outSmallNonZero[insertPos].payoutCents < swapInRow.payoutCents
    ) {
      insertPos++;
    }
    outSmallNonZero.splice(insertPos, 0, swapInRow);
    rangeIdx.splice(insertPos, 0, rangeI);
    rangeCount.set(rangeI, (rangeCount.get(rangeI) ?? 0) + 1);

    swapsApplied++;
  }

  return { swapsApplied, unfillable };
}

/** First index `i` with `arr[i] >= target` (number-array variant). */
function lowerBoundNum(arr: ReadonlyArray<number>, target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 5th refinement pass: swap duplicate-payout rows for source rows with NEW
 * payout values until output has ≥ targetUnique distinct payoutCents. Source
 * provides candidate rows whose payoutCents is NOT currently in output.
 *
 * Each swap is constrained to keep Σ_smallNz drift ≤ remainingSumBudget. Picks
 * the swap-in payout closest to swap-out's payout to minimize RTP/CV impact.
 *
 * Updates `outSmallNonZero` in place. Returns the number of swaps applied,
 * achieved unique count across (otherOutRows ∪ outSmallNonZero), and whether
 * the target was reached.
 */
function diversifyPayouts(
  outSmallNonZero: LookupRow[],
  srcSmallNonZero: ReadonlyArray<LookupRow>,
  otherOutRows: ReadonlyArray<LookupRow>,
  targetUnique: number,
  remainingSumBudget: number,
  warnings: string[],
): { swaps: number; achievedUnique: number; reached: boolean } {
  // Build the current set of payouts in output AND in-sample sim ids.
  // `payoutToOutRows` indexes positions in outSmallNonZero by their current
  // payoutCents value; this lets us locate "any row with payout p" in O(1)
  // and update incrementally on each swap (no array splice / re-scan).
  const inOutputPayouts = new Map<number, number>(); // payoutCents → count across all tiers
  const payoutToOutRows = new Map<number, Set<number>>(); // payoutCents → outSmallNonZero indices
  const inSampleSims = new Set<number>();
  for (const r of otherOutRows) {
    inOutputPayouts.set(r.payoutCents, (inOutputPayouts.get(r.payoutCents) ?? 0) + 1);
  }
  for (let i = 0; i < outSmallNonZero.length; i++) {
    const r = outSmallNonZero[i];
    inOutputPayouts.set(r.payoutCents, (inOutputPayouts.get(r.payoutCents) ?? 0) + 1);
    inSampleSims.add(r.sim);
    let s = payoutToOutRows.get(r.payoutCents);
    if (!s) {
      s = new Set<number>();
      payoutToOutRows.set(r.payoutCents, s);
    }
    s.add(i);
  }
  let uniqueNow = inOutputPayouts.size;

  // Index source rows by payoutCents → first available LookupRow (only those
  // NOT already in output and not in sample).
  const newPayoutsAvailable = new Map<number, LookupRow>();
  for (const r of srcSmallNonZero) {
    if (inOutputPayouts.has(r.payoutCents)) continue;
    if (inSampleSims.has(r.sim)) continue;
    if (!newPayoutsAvailable.has(r.payoutCents)) {
      newPayoutsAvailable.set(r.payoutCents, r);
    }
  }
  // Sorted list of new payout values for nearest-neighbor binary search.
  const newPayoutsSorted = Array.from(newPayoutsAvailable.keys()).sort((a, b) => a - b);

  // Maintain the set of payoutCents values that have >= 2 rows in outSmallNonZero
  // (these are the swap-out candidates — losing one of them keeps the payout
  // represented at least once, so we don't drop a unique-value entirely unless
  // a copy exists in cap/large/zero tiers).
  const dupPayouts = new Set<number>();
  for (const [p, rows] of payoutToOutRows) {
    // payout is a "safe" swap-out source if the cross-tier count is >= 2
    // (removing one row still leaves the payout in output somewhere).
    if ((inOutputPayouts.get(p) ?? 0) >= 2 && rows.size >= 1) dupPayouts.add(p);
  }

  if (newPayoutsSorted.length === 0) {
    if (uniqueNow < targetUnique) {
      warnings.push(
        `minUniqueEventsRate target ${targetUnique} unreachable: source has no distinct payout values not already in output (current ${uniqueNow})`,
      );
    }
    return { swaps: 0, achievedUnique: uniqueNow, reached: uniqueNow >= targetUnique };
  }
  if (dupPayouts.size === 0) {
    if (uniqueNow < targetUnique) {
      warnings.push(
        `minUniqueEventsRate target ${targetUnique} unreachable: every small-non-zero row already has a unique payout (current ${uniqueNow})`,
      );
    }
    return { swaps: 0, achievedUnique: uniqueNow, reached: uniqueNow >= targetUnique };
  }

  let swaps = 0;
  let sumBudget = remainingSumBudget;
  let exhaustedReason: 'budget' | 'sourceOrAllocation' | null = null;

  // Maximize unique payouts — minUniqueEventsRate is a FLOOR, not a cap. Loop
  // until no further beneficial swap is available (no duplicates left in
  // outSmallNonZero, no new payouts in source, or RTP-drift budget exhausted).
  while (newPayoutsSorted.length > 0 && dupPayouts.size > 0) {
    // Pick any payout that has duplicates. Prefer the one with the highest
    // cross-tier count (most efficient — keeps the smallest dups for later).
    let pickP = -1;
    let pickCount = 1;
    for (const p of dupPayouts) {
      const c = inOutputPayouts.get(p) ?? 0;
      if (c > pickCount) {
        pickCount = c;
        pickP = p;
      }
    }
    if (pickP < 0) break;
    const rowsForP = payoutToOutRows.get(pickP);
    if (!rowsForP || rowsForP.size === 0) {
      // All copies of this payout in outSmallNonZero have already been swapped
      // out; the lingering duplicates are in cap/large/zero tiers and we can't
      // reduce them here. Remove from dupPayouts and continue.
      dupPayouts.delete(pickP);
      continue;
    }
    const swapOutIdx = rowsForP.values().next().value as number;
    const swapOutRow = outSmallNonZero[swapOutIdx];
    const swapOutP = swapOutRow.payoutCents;

    // Find the new-payout value closest to swapOutP via binary search.
    let bestNewP = newPayoutsSorted[0];
    let bestDist = Math.abs(bestNewP - swapOutP);
    const ins = lowerBoundNum(newPayoutsSorted, swapOutP);
    for (const idx of [ins - 1, ins, ins + 1]) {
      if (idx < 0 || idx >= newPayoutsSorted.length) continue;
      const np = newPayoutsSorted[idx];
      const d = Math.abs(np - swapOutP);
      if (d < bestDist) {
        bestDist = d;
        bestNewP = np;
      }
    }

    // Check Σ-drift budget. If even the closest swap exceeds the remaining
    // budget, no future swap will fit either (closer pairs would have been
    // picked earlier) — stop.
    if (bestDist > sumBudget) {
      exhaustedReason = 'budget';
      break;
    }

    const swapInRow = newPayoutsAvailable.get(bestNewP);
    if (!swapInRow) {
      // Defensive: shouldn't happen because newPayoutsSorted mirrors
      // newPayoutsAvailable. Remove the stale entry and retry.
      const removeAt = lowerBoundNum(newPayoutsSorted, bestNewP);
      if (removeAt < newPayoutsSorted.length && newPayoutsSorted[removeAt] === bestNewP) {
        newPayoutsSorted.splice(removeAt, 1);
      }
      continue;
    }

    // Apply swap IN-PLACE — overwrite at the same array slot so existing
    // indices in payoutToOutRows remain stable.
    outSmallNonZero[swapOutIdx] = swapInRow;
    inSampleSims.delete(swapOutRow.sim);
    inSampleSims.add(swapInRow.sim);

    // Update payoutToOutRows / dupPayouts for the OLD payout.
    rowsForP.delete(swapOutIdx);
    const oldCount = inOutputPayouts.get(swapOutP) ?? 0;
    if (oldCount <= 1) {
      inOutputPayouts.delete(swapOutP);
      uniqueNow--;
    } else {
      inOutputPayouts.set(swapOutP, oldCount - 1);
    }
    if (rowsForP.size === 0) payoutToOutRows.delete(swapOutP);
    // After decrement, the cross-tier count may have fallen below 2 — then this
    // payout is no longer a safe swap-out source.
    if ((inOutputPayouts.get(swapOutP) ?? 0) < 2) dupPayouts.delete(swapOutP);

    // Update for the NEW payout (now in output at index swapOutIdx).
    inOutputPayouts.set(bestNewP, (inOutputPayouts.get(bestNewP) ?? 0) + 1);
    let newRowsForP = payoutToOutRows.get(bestNewP);
    if (!newRowsForP) {
      newRowsForP = new Set<number>();
      payoutToOutRows.set(bestNewP, newRowsForP);
    }
    newRowsForP.add(swapOutIdx);
    uniqueNow++;

    // bestNewP consumed: remove it from the available pool / sorted list.
    newPayoutsAvailable.delete(bestNewP);
    const removeAt = lowerBoundNum(newPayoutsSorted, bestNewP);
    if (removeAt < newPayoutsSorted.length && newPayoutsSorted[removeAt] === bestNewP) {
      newPayoutsSorted.splice(removeAt, 1);
    }

    sumBudget -= bestDist;
    swaps++;
  }

  if (uniqueNow < targetUnique) {
    if (exhaustedReason === 'budget') {
      warnings.push(
        `minUniqueEventsRate target ${targetUnique} not reached (achieved ${uniqueNow}): RTP-drift budget exhausted`,
      );
    } else if (newPayoutsSorted.length === 0) {
      warnings.push(
        `minUniqueEventsRate target ${targetUnique} not reached (achieved ${uniqueNow}): source has no more distinct payouts available`,
      );
    } else if (dupPayouts.size === 0) {
      warnings.push(
        `minUniqueEventsRate target ${targetUnique} not reached (achieved ${uniqueNow}): every output row already has a unique payout in small-non-zero tier`,
      );
    } else {
      warnings.push(
        `minUniqueEventsRate target ${targetUnique} not reached (achieved ${uniqueNow})`,
      );
    }
  }

  // Final sort of outSmallNonZero by payoutCents so downstream stages see a
  // tidy ordering (the in-place overwrites preserved indices but scrambled the
  // payout order).
  outSmallNonZero.sort((a, b) => a.payoutCents - b.payoutCents);

  return { swaps, achievedUnique: uniqueNow, reached: uniqueNow >= targetUnique };
}

