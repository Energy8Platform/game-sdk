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
  /** Optional: bias the candidate pool toward this non-zero fraction (0..1).
   *  When set, zeroBucket gets approximately `(1 − targetHitRate) × nRowsOut`
   *  slots and the log buckets share the rest. When unset, current
   *  variance-contribution distribution applies (zero gets leftover). */
  targetHitRate?: number;
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
  const { nRowsOut, minPerBucket, requireMaxReached, targetHitRate } = params;

  // Count non-empty log buckets — these are the ones eligible for minPerBucket.
  const nonEmptyLogCount = buckets.logBuckets.reduce(
    (s, b) => s + (b.indices.length > 0 ? 1 : 0),
    0,
  );
  const wantNearMax = requireMaxReached && buckets.nearMaxBucket.indices.length > 0;

  const totalAvailable =
    buckets.zeroBucket.indices.length +
    buckets.logBuckets.reduce((s, b) => s + b.indices.length, 0) +
    buckets.nearMaxBucket.indices.length;
  const expected = Math.min(nRowsOut, totalAvailable);

  // ── targetHitRate-biased path ────────────────────────────────────────────
  if (typeof targetHitRate === 'number' && targetHitRate > 0 && targetHitRate < 1) {
    const result = computeQuotasByTargetHitRate(buckets, {
      nRowsOut,
      minPerBucket,
      requireMaxReached,
      targetHitRate,
      nonEmptyLogCount,
      wantNearMax,
      totalAvailable,
      expected,
    });
    return result;
  }

  // ── Original variance-contribution path ──────────────────────────────────
  // Compute an effective minPerBucket so the floor allocation does not exceed nRowsOut.
  // Floor at 0; near-max keeps its 1 slot when room allows, dropped only as a last resort.
  let effectiveMinPerBucket = minPerBucket;
  while (
    effectiveMinPerBucket > 0 &&
    nonEmptyLogCount * effectiveMinPerBucket + (wantNearMax ? 1 : 0) > nRowsOut
  ) {
    effectiveMinPerBucket--;
  }
  let nearMaxQuota = wantNearMax && nonEmptyLogCount * effectiveMinPerBucket < nRowsOut ? 1 : 0;

  const logQuotas = buckets.logBuckets.map((b) => {
    if (b.indices.length === 0) return 0;
    return Math.min(effectiveMinPerBucket, b.indices.length);
  });

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

  const zeroQuota = Math.max(0, Math.min(remaining, buckets.zeroBucket.indices.length));
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

  // Defensive invariant: quotas must sum to exactly nRowsOut, unless the
  // total available indices across all buckets are fewer than nRowsOut (in
  // which case the cap at total available is the best achievable).
  const total = zeroQuota + logQuotas.reduce((s, q) => s + q, 0) + nearMaxQuota;
  if (total !== expected) {
    throw new Error(
      `computeQuotas invariant violated: total=${total}, expected=${expected} (nRowsOut=${nRowsOut}, totalAvailable=${totalAvailable})`,
    );
  }

  return { zeroBucket: zeroQuota, logBuckets: logQuotas, nearMaxBucket: nearMaxQuota };
}

/**
 * Splits `nRowsOut` so the candidate pool's non-zero fraction ≈ `targetHitRate`.
 * This fixes the lopsided-row-composition bug in `optimizeLookupTable` when the
 * source distribution's natural hit-rate is far from `targetHitRate`.
 *
 * The non-zero share is distributed across log + near-max buckets using the same
 * (minPerBucket floor → variance-contribution remainder) heuristic as the
 * default path, but constrained to a smaller budget. Any shortfall in either
 * the zero or non-zero side spills over to the other side so total === nRowsOut.
 */
function computeQuotasByTargetHitRate(
  buckets: QuotaInput,
  ctx: {
    nRowsOut: number;
    minPerBucket: number;
    requireMaxReached: boolean;
    targetHitRate: number;
    nonEmptyLogCount: number;
    wantNearMax: boolean;
    totalAvailable: number;
    expected: number;
  },
): Quotas {
  const { nRowsOut, minPerBucket, targetHitRate, nonEmptyLogCount, wantNearMax, totalAvailable, expected } = ctx;

  const nonZeroAvailable =
    buckets.logBuckets.reduce((s, b) => s + b.indices.length, 0) +
    buckets.nearMaxBucket.indices.length;
  const zeroAvailable = buckets.zeroBucket.indices.length;

  let nonZeroSlots = Math.round(targetHitRate * nRowsOut);
  let zeroSlots = nRowsOut - nonZeroSlots;

  // Cap each side by what's available; spill the leftover to the other side.
  if (nonZeroSlots > nonZeroAvailable) {
    zeroSlots += nonZeroSlots - nonZeroAvailable;
    nonZeroSlots = nonZeroAvailable;
  }
  if (zeroSlots > zeroAvailable) {
    nonZeroSlots += zeroSlots - zeroAvailable;
    zeroSlots = zeroAvailable;
  }
  // Final cap (only matters when totalAvailable < nRowsOut).
  if (nonZeroSlots > nonZeroAvailable) nonZeroSlots = nonZeroAvailable;
  if (zeroSlots > zeroAvailable) zeroSlots = zeroAvailable;

  // Scale effectiveMinPerBucket down so the floor allocation fits within the
  // non-zero budget. Same logic as the default path, just constrained to
  // `nonZeroSlots` instead of `nRowsOut`.
  let effectiveMinPerBucket = minPerBucket;
  while (
    effectiveMinPerBucket > 0 &&
    nonEmptyLogCount * effectiveMinPerBucket + (wantNearMax ? 1 : 0) > nonZeroSlots
  ) {
    effectiveMinPerBucket--;
  }
  let nearMaxQuota =
    wantNearMax && nonEmptyLogCount * effectiveMinPerBucket < nonZeroSlots ? 1 : 0;

  const logQuotas = buckets.logBuckets.map((b) => {
    if (b.indices.length === 0) return 0;
    return Math.min(effectiveMinPerBucket, b.indices.length);
  });

  let assigned = logQuotas.reduce((s, q) => s + q, 0) + nearMaxQuota;
  let remainingNonZero = nonZeroSlots - assigned;

  // Variance-contribution remainder, with redistribution when any bucket caps
  // out (so the non-zero budget gets fully consumed before spilling to zero).
  if (remainingNonZero > 0) {
    const contrib = buckets.logBuckets.map((b) => {
      if (b.indices.length === 0) return 0;
      const mean = b.weightedPayoutSum / Math.max(1, b.totalWeight);
      return b.totalWeight * mean * mean;
    });
    // Iteratively allocate by contribution among non-capped buckets, then
    // redistribute any over-allocation. Capped at log(nBuckets) + 1 passes.
    let extraToPlace = remainingNonZero;
    const eligible = buckets.logBuckets.map((b, i) => b.indices.length - logQuotas[i] > 0);
    const maxPasses = buckets.logBuckets.length + 2;
    for (let pass = 0; pass < maxPasses && extraToPlace > 0; pass++) {
      let activeContrib = 0;
      for (let i = 0; i < buckets.logBuckets.length; i++) {
        if (eligible[i]) activeContrib += contrib[i];
      }
      if (activeContrib > 0) {
        const proposed = buckets.logBuckets.map((_, i) =>
          eligible[i] ? (contrib[i] / activeContrib) * extraToPlace : 0,
        );
        const floors = proposed.map(Math.floor);
        const used = floors.reduce((s, v) => s + v, 0);
        const remainders = proposed.map((p, i) => p - floors[i]);
        const order = remainders
          .map((_, i) => i)
          .filter((i) => eligible[i])
          .sort((a, b) => remainders[b] - remainders[a]);
        let extra = extraToPlace - used;
        for (const i of order) {
          if (extra === 0) break;
          floors[i]++;
          extra--;
        }
        // Apply, capping at room.
        let placed = 0;
        for (let i = 0; i < floors.length; i++) {
          if (!eligible[i] || floors[i] <= 0) continue;
          const room = buckets.logBuckets[i].indices.length - logQuotas[i];
          const give = Math.min(floors[i], room);
          logQuotas[i] += give;
          placed += give;
          if (give === room) eligible[i] = false;
        }
        extraToPlace -= placed;
        if (placed === 0) break; // No progress (everything is capped).
      } else {
        // No variance signal among eligible — fill remaining buckets evenly by room.
        const order = buckets.logBuckets
          .map((b, i) => ({ i, room: b.indices.length - logQuotas[i] }))
          .filter((o) => o.room > 0 && eligible[o.i])
          .sort((a, b) => b.room - a.room);
        for (const { i, room } of order) {
          if (extraToPlace === 0) break;
          const give = Math.min(room, extraToPlace);
          logQuotas[i] += give;
          extraToPlace -= give;
        }
        break;
      }
    }
    remainingNonZero = extraToPlace;
  }

  // If any non-zero slot is still unassigned (every log bucket capped),
  // spill it to zero (only path left when totalAvailable still allows it).
  if (remainingNonZero > 0) {
    const headroomToZero = Math.min(remainingNonZero, zeroAvailable - zeroSlots);
    zeroSlots += headroomToZero;
    remainingNonZero -= headroomToZero;
  }

  let zeroQuota = Math.min(zeroSlots, zeroAvailable);

  // If zero bucket can't soak its share, spill to the largest log buckets.
  let leftover = zeroSlots - zeroQuota;
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
    if (leftover > 0 && wantNearMax && nearMaxQuota === 0 && buckets.nearMaxBucket.indices.length > 0) {
      nearMaxQuota = 1;
      leftover--;
    }
  }

  // Final defensive invariant.
  const total = zeroQuota + logQuotas.reduce((s, q) => s + q, 0) + nearMaxQuota;
  if (total !== expected) {
    throw new Error(
      `computeQuotas invariant violated (targetHitRate path): total=${total}, expected=${expected} (nRowsOut=${nRowsOut}, totalAvailable=${totalAvailable}, targetHitRate=${targetHitRate})`,
    );
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
  const totalQuota =
    quotas.zeroBucket + quotas.logBuckets.reduce((s, q) => s + q, 0) + quotas.nearMaxBucket;

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

  // 4. Top up any shortfall caused by overlapping buckets (e.g. near-max
  //    consumes indices a log bucket also wanted). Sample the remainder of
  //    `rows` (anything not already chosen) by weight.
  if (chosen.size < totalQuota) {
    const remIdx: number[] = [];
    const remW: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!chosen.has(i)) {
        remIdx.push(i);
        remW.push(rows[i].weight);
      }
    }
    const need = totalQuota - chosen.size;
    for (const idx of weightedReservoirSample(remIdx, remW, need, rng)) {
      chosen.add(idx);
    }
  }

  const out = [...chosen];
  if (out.length !== totalQuota) {
    throw new Error(
      `stratifiedSample invariant violated: produced ${out.length}, expected ${totalQuota}`,
    );
  }
  return out;
}
