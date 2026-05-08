// src/sample.ts
import type { BucketizeResult, Bucket } from './bucketize.js';

/** Mulberry32 — small deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
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
 * Weighted reservoir sampling without replacement (Algorithm A-Res, Efraimidis & Spirakis).
 * Each item gets a key u^(1/w); we keep the top-k keys.
 *
 * Returns the chosen indices (subset of `indices`).
 */
export function weightedReservoirSample(
  indices: ReadonlyArray<number>,
  weights: ReadonlyArray<number>,
  k: number,
  rng: () => number,
): number[] {
  const n = indices.length;
  if (k >= n) return [...indices];
  if (k <= 0) return [];

  // Min-heap of {key, idx} sized k. Inline implementation (no deps).
  const heapKeys: number[] = [];
  const heapIdx: number[] = [];

  const swap = (i: number, j: number) => {
    [heapKeys[i], heapKeys[j]] = [heapKeys[j], heapKeys[i]];
    [heapIdx[i], heapIdx[j]] = [heapIdx[j], heapIdx[i]];
  };
  const siftUp = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKeys[p] > heapKeys[i]) { swap(p, i); i = p; } else break;
    }
  };
  const siftDown = (i: number) => {
    const sz = heapKeys.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let s = i;
      if (l < sz && heapKeys[l] < heapKeys[s]) s = l;
      if (r < sz && heapKeys[r] < heapKeys[s]) s = r;
      if (s !== i) { swap(s, i); i = s; } else break;
    }
  };

  for (let i = 0; i < n; i++) {
    const w = weights[i];
    if (w <= 0) continue;
    // key = u^(1/w) — equivalently log(u)/w; use log form for numerical stability with huge w
    const u = rng();
    const key = Math.log(u) / w;
    if (heapKeys.length < k) {
      heapKeys.push(key);
      heapIdx.push(indices[i]);
      siftUp(heapKeys.length - 1);
    } else if (key > heapKeys[0]) {
      heapKeys[0] = key;
      heapIdx[0] = indices[i];
      siftDown(0);
    }
  }

  return heapIdx.slice();
}

export interface QuotaInput {
  zeroBucket: Bucket;
  logBuckets: Bucket[];
  nearMaxBucket: Bucket;
}

export interface QuotaParams {
  nRowsOut: number;
  minPerBucket: number;
  requireMaxReached: boolean;
}

export interface Quotas {
  zeroBucket: number;
  logBuckets: number[];
  nearMaxBucket: number;
}

/**
 * Distributes `nRowsOut` slots across (zero, log[…], nearMax) buckets:
 *   1. Each non-empty non-zero log bucket gets `minPerBucket` (capped at bucket size).
 *   2. nearMax gets ≥ 1 if requireMaxReached and non-empty.
 *   3. Remaining slots → distributed proportional to bucket variance contribution
 *      (weight × meanPayout²), capped at bucket size.
 *   4. zeroBucket absorbs the leftover.
 *
 * All quotas are integers and sum to nRowsOut.
 */
export function computeQuotas(buckets: QuotaInput, params: QuotaParams): Quotas {
  const { nRowsOut, minPerBucket, requireMaxReached } = params;
  const logQuotas = buckets.logBuckets.map((b) => {
    if (b.indices.length === 0) return 0;
    return Math.min(minPerBucket, b.indices.length);
  });
  let nearMaxQuota = 0;
  if (requireMaxReached && buckets.nearMaxBucket.indices.length > 0) {
    nearMaxQuota = 1;
  }

  let assigned = logQuotas.reduce((s, q) => s + q, 0) + nearMaxQuota;
  let remaining = nRowsOut - assigned;

  // Variance-contribution distribution
  if (remaining > 0) {
    const contrib = buckets.logBuckets.map((b) => {
      if (b.indices.length === 0) return 0;
      const mean = b.weightedPayoutSum / Math.max(1, b.totalWeight);
      return b.totalWeight * mean * mean;
    });
    const totalContrib = contrib.reduce((s, v) => s + v, 0);
    if (totalContrib > 0) {
      const proposed = contrib.map((c) => (c / totalContrib) * remaining);
      // Floor + largest-remainder
      const floors = proposed.map(Math.floor);
      let used = floors.reduce((s, v) => s + v, 0);
      const remainders = proposed.map((p, i) => p - floors[i]);
      const order = remainders
        .map((_, i) => i)
        .sort((a, b) => remainders[b] - remainders[a]);
      let extra = remaining - used;
      for (const i of order) {
        if (extra === 0) break;
        floors[i]++;
        extra--;
      }
      // Cap each at (bucket size − minPerBucket already given)
      for (let i = 0; i < floors.length; i++) {
        const room = buckets.logBuckets[i].indices.length - logQuotas[i];
        if (floors[i] > room) {
          floors[i] = room;
        }
        logQuotas[i] += floors[i];
      }
    }
    assigned = logQuotas.reduce((s, q) => s + q, 0) + nearMaxQuota;
    remaining = nRowsOut - assigned;
  }

  const zeroQuota = Math.min(remaining, buckets.zeroBucket.indices.length);
  // If zero bucket can't soak it all up, dump the rest into the largest log bucket
  let leftover = remaining - zeroQuota;
  if (leftover > 0) {
    const order = buckets.logBuckets
      .map((b, i) => ({ i, room: b.indices.length - logQuotas[i] }))
      .sort((a, b) => b.room - a.room);
    for (const { i, room } of order) {
      if (leftover === 0) break;
      const give = Math.min(room, leftover);
      logQuotas[i] += give;
      leftover -= give;
    }
  }

  return { zeroBucket: zeroQuota, logBuckets: logQuotas, nearMaxBucket: nearMaxQuota };
}

/**
 * Apply quotas: sample row indices from each bucket using weighted reservoir sampling.
 * Returns the union of sampled indices.
 *
 * Note: nearMax bucket overlaps with log buckets, so we sample it first and then
 * skip those indices when sampling the log buckets to avoid duplicates.
 */
export function stratifiedSample(
  buckets: QuotaInput,
  rows: ReadonlyArray<{ weight: number }>,
  quotas: Quotas,
  rng: () => number,
): number[] {
  const chosen = new Set<number>();

  // 1. Near-max first (these indices may overlap log buckets)
  if (quotas.nearMaxBucket > 0 && buckets.nearMaxBucket.indices.length > 0) {
    const w = buckets.nearMaxBucket.indices.map((i) => rows[i].weight);
    for (const idx of weightedReservoirSample(buckets.nearMaxBucket.indices, w, quotas.nearMaxBucket, rng)) {
      chosen.add(idx);
    }
  }

  // 2. Log buckets, excluding already-chosen indices
  for (let bi = 0; bi < buckets.logBuckets.length; bi++) {
    const need = quotas.logBuckets[bi];
    if (need <= 0) continue;
    const filteredIdx: number[] = [];
    const filteredW: number[] = [];
    for (const i of buckets.logBuckets[bi].indices) {
      if (!chosen.has(i)) {
        filteredIdx.push(i);
        filteredW.push(rows[i].weight);
      }
    }
    for (const idx of weightedReservoirSample(filteredIdx, filteredW, need, rng)) {
      chosen.add(idx);
    }
  }

  // 3. Zero bucket
  if (quotas.zeroBucket > 0) {
    const w = buckets.zeroBucket.indices.map((i) => rows[i].weight);
    for (const idx of weightedReservoirSample(buckets.zeroBucket.indices, w, quotas.zeroBucket, rng)) {
      chosen.add(idx);
    }
  }

  return [...chosen];
}
