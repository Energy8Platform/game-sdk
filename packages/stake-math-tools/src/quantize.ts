// src/quantize.ts

/**
 * Largest-remainder quantization with a strict per-row floor of 1.
 *
 *   - input:  continuous weights wᵢ ≥ 0, target sum T (integer)
 *   - output: integer weights wᵢ′ ≥ 1, Σwᵢ′ = T (exact)
 *
 * Throws if T < weights.length, since wᵢ′ ≥ 1 then can't sum to T.
 *
 * Tie-breaking: when multiple rows have the same remainder, lower index wins
 * (deterministic; matches the order indices come back from a stable sort).
 */
export function quantizeWeights(weights: ReadonlyArray<number>, total: number): number[] {
  const n = weights.length;
  if (total < n) {
    throw new Error(`quantizeWeights: total (${total}) must be >= n (${n}); cannot satisfy w_i >= 1`);
  }

  const floors = weights.map((w) => Math.max(1, Math.floor(w)));
  let sumFloors = 0;
  for (const v of floors) sumFloors += v;

  let deficit = total - sumFloors; // positive: need to add; negative: need to remove

  if (deficit > 0) {
    // Add 1's to rows with the largest remainder = w − floor(w).
    // (When floor was clamped to 1 because raw floor was 0, the "remainder" we
    //  care about is the leftover capacity above 1, i.e. max(0, w − 1).)
    // Round to 10 decimal places to suppress floating-point noise so that
    // conceptually equal remainders compare equal and lower-index wins on tie.
    const remainders = weights.map((w, i) =>
      Math.round(Math.max(0, w - floors[i]) * 1e10) / 1e10,
    );
    const order = indicesSortedByDesc(remainders);
    // Distribute deficit across rows. If deficit > n, give each row floor(deficit/n)
    // plus one extra to the top (deficit % n) rows.
    const bulk = Math.floor(deficit / n);
    if (bulk > 0) for (let i = 0; i < n; i++) floors[i] += bulk;
    const remainder = deficit - bulk * n;
    for (let k = 0; k < remainder; k++) floors[order[k]]++;
  } else if (deficit < 0) {
    // Remove 1's from rows with the largest current weight, never going below 1.
    // Single sort + single greedy pass: from the largest-floor row downward,
    // take as much as possible (capped by floors[i] − 1) until toRemove == 0.
    // O(n log n) total — previously O(K · n log n) when many rows are clamped at 1.
    let toRemove = -deficit;
    const order = indicesSortedByDesc(floors);
    for (const i of order) {
      if (toRemove === 0) break;
      const removable = floors[i] - 1;
      if (removable > 0) {
        const take = Math.min(removable, toRemove);
        floors[i] -= take;
        toRemove -= take;
      }
    }
    if (toRemove > 0) {
      // Shouldn't happen: total >= n was checked; sumFloors was at most total + (max(1, .) bias),
      // and that bias is ≤ n which can always be reclaimed.
      throw new Error('quantizeWeights: cannot reduce further while keeping w_i >= 1');
    }
  }

  return floors;
}

function indicesSortedByDesc(values: ReadonlyArray<number>): number[] {
  const idx = values.map((_, i) => i);
  // Stable sort: ties preserve original (ascending) index — lower index wins.
  // We add a secondary sort on index to make tie-breaking explicit and immune
  // to floating-point near-equality issues.
  idx.sort((a, b) => {
    const diff = values[b] - values[a];
    if (diff !== 0) return diff;
    return a - b; // lower index wins on tie
  });
  return idx;
}
