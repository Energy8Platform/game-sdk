// src/bucketize.ts
import type { LookupRow } from './types.js';

export interface Bucket {
  /** Indices into the original rows array. */
  indices: number[];
  /** Σ weight of rows in this bucket. */
  totalWeight: number;
  /** Σ (weight × payout) — used by stratified sampling for variance-contribution heuristic. */
  weightedPayoutSum: number;
}

export interface BucketizeResult {
  zeroBucket: Bucket;
  /** Length = bucketCount; some buckets may be empty (totalWeight = 0). */
  logBuckets: Bucket[];
  /** Rows with payout ≥ maxReachedFraction × capMaxWin. May overlap with the top log bucket. */
  nearMaxBucket: Bucket;
}

export interface BucketizeOptions {
  capMaxWin: number;
  bucketCount: number;
  maxReachedFraction: number;
}

/**
 * Partitions rows into:
 *   - one zero-payout bucket
 *   - `bucketCount` log-spaced buckets between min-nonzero payout and capMaxWin
 *   - one near-max bucket (payout ≥ maxReachedFraction × capMaxWin)
 *
 * The near-max bucket overlaps with the top log bucket(s) — the optimizer uses it
 * to enforce the "max-reached" constraint in phase 3 (sampling), not to displace
 * the log buckets.
 *
 * Caller is expected to have already filtered `payoutCents > capMaxWin` rows out.
 * If any slip through, they are placed into the top log bucket but trip nothing —
 * defensive behavior.
 */
export function bucketize(
  rows: ReadonlyArray<LookupRow>,
  options: BucketizeOptions,
): BucketizeResult {
  const { capMaxWin, bucketCount, maxReachedFraction } = options;

  // First pass: find min-nonzero payout
  let minNonzero = Infinity;
  for (const r of rows) {
    if (r.payoutCents > 0 && r.payoutCents < minNonzero) minNonzero = r.payoutCents;
  }
  // If there's no nonzero payout at all, log buckets are empty
  const hasNonzero = isFinite(minNonzero);

  const logMin = hasNonzero ? Math.log(minNonzero) : 0;
  const logMax = Math.log(Math.max(minNonzero, capMaxWin));
  const logSpan = Math.max(logMax - logMin, 1e-9);
  const nearMaxThreshold = maxReachedFraction * capMaxWin;

  const zeroBucket: Bucket = { indices: [], totalWeight: 0, weightedPayoutSum: 0 };
  const logBuckets: Bucket[] = Array.from({ length: bucketCount }, () => ({
    indices: [],
    totalWeight: 0,
    weightedPayoutSum: 0,
  }));
  const nearMaxBucket: Bucket = { indices: [], totalWeight: 0, weightedPayoutSum: 0 };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.payoutCents === 0) {
      zeroBucket.indices.push(i);
      zeroBucket.totalWeight += r.weight;
      // weightedPayoutSum stays 0
      continue;
    }

    // Pick log bucket
    let bucketIdx: number;
    if (!hasNonzero || logSpan === 0) {
      bucketIdx = 0;
    } else {
      const t = (Math.log(r.payoutCents) - logMin) / logSpan;
      bucketIdx = Math.min(bucketCount - 1, Math.max(0, Math.floor(t * bucketCount)));
    }
    const b = logBuckets[bucketIdx];
    b.indices.push(i);
    b.totalWeight += r.weight;
    b.weightedPayoutSum += r.weight * r.payoutCents;

    // Near-max bucket (overlaps top log buckets — that's intentional)
    if (r.payoutCents >= nearMaxThreshold) {
      nearMaxBucket.indices.push(i);
      nearMaxBucket.totalWeight += r.weight;
      nearMaxBucket.weightedPayoutSum += r.weight * r.payoutCents;
    }
  }

  return { zeroBucket, logBuckets, nearMaxBucket };
}
