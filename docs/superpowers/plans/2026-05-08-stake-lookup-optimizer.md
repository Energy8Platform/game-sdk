# Stake lookup-table optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a node-only TypeScript library `optimizeLookupTable(rows, params)` in a new monorepo package `@energy8platform/stake-math-tools` that picks an N-row weighted lookup table from a raw simulation dump, hitting target RTP / CV / hit-rate within tolerance under a `capMaxWin` ceiling.

**Architecture:** Six-phase pipeline — filter+stats → log-bucketize → stratified weighted-reservoir sample → NNLS weight solve (Lawson–Hanson with Tikhonov + sum-row penalty) under fixed-point iteration on μ̂ → largest-remainder integer quantization (`wᵢ ≥ 1`) → verify-and-retry up to `maxIterations` times.

**Tech Stack:** TypeScript 5.6, ESM, Node 20+, vitest 1.x for tests, BigInt for accumulators, Float64 for solver. Zero runtime dependencies.

**Spec reference:** [docs/superpowers/specs/2026-05-08-stake-lookup-optimizer-design.md](../specs/2026-05-08-stake-lookup-optimizer-design.md)

---

## File structure (created across these tasks)

```
packages/stake-math-tools/
  package.json                                // Task 1
  tsconfig.json                               // Task 1
  vitest.config.ts                            // Task 1
  src/
    types.ts                                  // Task 2
    metrics.ts                                // Task 3
    quantize.ts                               // Task 4
    bucketize.ts                              // Task 5
    sample.ts                                 // Task 6
    nnls.ts                                   // Task 7
    optimize-lookup.ts                        // Task 8
    index.ts                                  // Task 10
  test/
    metrics.test.ts                           // Task 3
    quantize.test.ts                          // Task 4
    bucketize.test.ts                         // Task 5
    sample.test.ts                            // Task 6
    nnls.test.ts                              // Task 7
    optimize-lookup.integration.test.ts       // Task 9
```

Root `package.json` `build` script gets a `-w @energy8platform/stake-math-tools` extension only if/when we want type-checking via the existing build step (see Task 10).

---

### Task 1: Package skeleton

**Files:**
- Create: `packages/stake-math-tools/package.json`
- Create: `packages/stake-math-tools/tsconfig.json`
- Create: `packages/stake-math-tools/vitest.config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@energy8platform/stake-math-tools",
  "version": "0.1.0",
  "description": "Node-only dev-time math utilities for the Energy8 Stake bridge: lookup-table (force matrix) builder",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

No `build` step — the package is consumed by tsx-style runners and tests in this monorepo, never published.

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2020"],
    "types": ["node"]
  },
  "include": ["src", "test"],
  "exclude": ["node_modules", "dist"]
}
```

(Drops the `DOM` lib that the base config sets for browser packages — this is node-only.)

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 4: Install vitest at the workspace root**

Run: `cd /Users/mrphelko/Documents/repo/energy8-platform-game-sdk && npm install --workspace @energy8platform/stake-math-tools`
Expected: `vitest` and its deps installed under root `node_modules`. No errors.

- [ ] **Step 5: Verify the empty test setup runs**

Run: `cd packages/stake-math-tools && npx vitest run`
Expected: vitest reports `No test files found` and exits 0 — proves the test runner is wired up.

- [ ] **Step 6: Commit**

```bash
git add packages/stake-math-tools/package.json packages/stake-math-tools/tsconfig.json packages/stake-math-tools/vitest.config.ts package-lock.json package.json
git commit -m "stake-math-tools: package skeleton"
```

---

### Task 2: Type definitions

**Files:**
- Create: `packages/stake-math-tools/src/types.ts`

- [ ] **Step 1: Write types.ts**

```ts
export interface LookupRow {
  /** Simulation number — opaque identifier, preserved on output. */
  sim: number;
  /** Input weight, integer (typically large, e.g. 1.99e11). */
  weight: number;
  /** Payout multiplier × 100, integer, ≥ 0. */
  payoutCents: number;
}

export interface OptimizeParams {
  targetRTP: number;
  toleranceRTP: number;

  targetCV: number;
  toleranceCV: number;

  targetHitRate: number;
  toleranceHitRate: number;

  /** Hard cap. Rows with payoutCents > capMaxWin are dropped. */
  capMaxWin: number;

  /** When true, force ≥ 1 row with payoutCents ≥ maxReachedFraction × capMaxWin. Default true. */
  requireMaxReached?: boolean;
  /** Default 0.95. */
  maxReachedFraction?: number;

  nRowsOut: number;
  /** Sum of integer output weights. Default = nRowsOut × 1_000_000. Must be ≥ nRowsOut. */
  totalWeightOut?: number;

  /** Sampling RNG seed. Default 0xC0FFEE. */
  seed?: number;
  /** Expand-and-retry attempts on tolerance miss. Default 5. */
  maxIterations?: number;
  /** Number of log-buckets between min-nonzero and capMaxWin. Default 100. */
  bucketCount?: number;
  /** Minimum sample slots per non-empty non-zero bucket. Default 3. */
  minPerBucket?: number;
}

export interface OptimizeAchieved {
  rtp: number;
  cv: number;
  hitRate: number;
  maxPayout: number;
  totalWeight: number;
}

export interface ToleranceMet {
  rtp: boolean;
  cv: boolean;
  hitRate: boolean;
  maxReached: boolean;
}

export interface OptimizeResult {
  rows: LookupRow[];
  achieved: OptimizeAchieved;
  toleranceMet: ToleranceMet;
  warnings: string[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/stake-math-tools && npm run typecheck`
Expected: PASS, no output.

- [ ] **Step 3: Commit**

```bash
git add packages/stake-math-tools/src/types.ts
git commit -m "stake-math-tools: public types"
```

---

### Task 3: Metrics module (weighted RTP / CV / hit-rate / near-max)

**Files:**
- Create: `packages/stake-math-tools/test/metrics.test.ts`
- Create: `packages/stake-math-tools/src/metrics.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/metrics.test.ts
import { describe, expect, it } from 'vitest';
import { computeMetrics, isNearMax } from '../src/metrics.js';
import type { LookupRow } from '../src/types.js';

describe('computeMetrics', () => {
  it('returns weighted RTP, CV, hitRate, maxPayout, totalWeight on a hand-checked input', () => {
    // 4 rows, weight=1 each: payouts 0, 100, 200, 100
    // mean payout = (0 + 100 + 200 + 100) / 4 = 100
    // RTP = mean / 100 = 1.0
    // var = ((0-100)^2 + 0 + (200-100)^2 + 0) / 4 = 5000
    // stddev = sqrt(5000) ≈ 70.7106781
    // CV = stddev / mean ≈ 0.7071068
    // hitRate = 3/4 = 0.75
    const rows: LookupRow[] = [
      { sim: 1, weight: 1, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 100 },
      { sim: 3, weight: 1, payoutCents: 200 },
      { sim: 4, weight: 1, payoutCents: 100 },
    ];

    const m = computeMetrics(rows);

    expect(m.totalWeight).toBe(4);
    expect(m.rtp).toBeCloseTo(1.0, 10);
    expect(m.maxPayout).toBe(200);
    expect(m.hitRate).toBeCloseTo(0.75, 10);
    expect(m.cv).toBeCloseTo(Math.sqrt(5000) / 100, 10);
  });

  it('honors weights (non-uniform)', () => {
    // 2 rows: (w=3, p=0), (w=1, p=400) → totalW=4, mean=100, RTP=1.0, hitRate=0.25
    const rows: LookupRow[] = [
      { sim: 1, weight: 3, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 400 },
    ];
    const m = computeMetrics(rows);
    expect(m.rtp).toBeCloseTo(1.0, 10);
    expect(m.hitRate).toBeCloseTo(0.25, 10);
  });

  it('returns CV=0 and rtp=0 when all payouts are zero', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 5, payoutCents: 0 },
      { sim: 2, weight: 7, payoutCents: 0 },
    ];
    const m = computeMetrics(rows);
    expect(m.rtp).toBe(0);
    expect(m.cv).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.maxPayout).toBe(0);
  });
});

describe('isNearMax', () => {
  it('returns true when payout ≥ fraction × cap', () => {
    expect(isNearMax(950, 1000, 0.95)).toBe(true);
    expect(isNearMax(1000, 1000, 0.95)).toBe(true);
    expect(isNearMax(949, 1000, 0.95)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/stake-math-tools && npx vitest run test/metrics.test.ts`
Expected: FAIL — `Cannot find module '../src/metrics.js'`.

- [ ] **Step 3: Implement metrics.ts**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/stake-math-tools && npx vitest run test/metrics.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/stake-math-tools/src/metrics.ts packages/stake-math-tools/test/metrics.test.ts
git commit -m "stake-math-tools: weighted RTP/CV/hitRate metrics"
```

---

### Task 4: Integer quantization (largest-remainder)

**Files:**
- Create: `packages/stake-math-tools/test/quantize.test.ts`
- Create: `packages/stake-math-tools/src/quantize.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/quantize.test.ts
import { describe, expect, it } from 'vitest';
import { quantizeWeights } from '../src/quantize.js';

describe('quantizeWeights', () => {
  it('exactly preserves the target sum (deficit > 0 case)', () => {
    // floors = [10, 20, 30, 40] → sum 100; total 103 → deficit 3
    // remainders all 0.7 → tie; first 3 indices get +1
    const out = quantizeWeights([10.7, 20.7, 30.7, 40.7], 103);
    expect(out.reduce((a, b) => a + b, 0)).toBe(103);
    expect(out).toEqual([11, 21, 31, 40]);
  });

  it('exactly preserves the target sum (deficit < 0 case)', () => {
    // floors max(1, ...) = [10, 20, 30, 40] → sum 100; total 99 → deficit -1
    // largest current weight is 40 → decrement to 39
    const out = quantizeWeights([10.7, 20.3, 30.7, 40.3], 99);
    expect(out.reduce((a, b) => a + b, 0)).toBe(99);
    expect(out).toEqual([10, 20, 30, 39]);
  });

  it('clamps each output to ≥ 1 (so output never drops a row)', () => {
    // floors = [1, 1, 1, 100] sum 103; total 103 → deficit 0
    // (raw floor of 0.1 would be 0, but max(1, …) bumps it to 1)
    const out = quantizeWeights([0.1, 0.2, 0.3, 100], 103);
    expect(out.length).toBe(4);
    for (const w of out) expect(w).toBeGreaterThanOrEqual(1);
    expect(out.reduce((a, b) => a + b, 0)).toBe(103);
  });

  it('throws when total < n (impossible to satisfy w_i ≥ 1)', () => {
    expect(() => quantizeWeights([1, 1, 1], 2)).toThrow(/total.*>= n/);
  });

  it('handles ties deterministically (lower index wins on tie)', () => {
    // all remainders 0.5, total 12 → floors [1,1,1,1,1] sum 5… wait
    // for a clean test: weights [1.5, 2.5, 3.5], floors=[1,2,3] sum 6, total 8 → deficit 2
    // all remainders are 0.5 → indices 0 and 1 should win (lower index breaks ties)
    const out = quantizeWeights([1.5, 2.5, 3.5], 8);
    expect(out).toEqual([2, 3, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/stake-math-tools && npx vitest run test/quantize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement quantize.ts**

```ts
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
    const remainders = weights.map((w, i) => Math.max(0, w - floors[i]));
    const order = indicesSortedByDesc(remainders);
    for (let k = 0; k < deficit; k++) floors[order[k]]++;
  } else if (deficit < 0) {
    // Remove 1's from rows with the largest current weight, never going below 1.
    let toRemove = -deficit;
    while (toRemove > 0) {
      const order = indicesSortedByDesc(floors);
      let progress = false;
      for (const i of order) {
        if (toRemove === 0) break;
        if (floors[i] > 1) {
          floors[i]--;
          toRemove--;
          progress = true;
        }
      }
      if (!progress) {
        // Shouldn't happen: total >= n was checked; sumFloors was at most total + (max(1, .) bias),
        // and that bias is ≤ n which can always be reclaimed.
        throw new Error('quantizeWeights: cannot reduce further while keeping w_i >= 1');
      }
    }
  }

  return floors;
}

function indicesSortedByDesc(values: ReadonlyArray<number>): number[] {
  const idx = values.map((_, i) => i);
  // Stable sort: ties preserve original (ascending) index — lower index wins.
  idx.sort((a, b) => values[b] - values[a]);
  return idx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/stake-math-tools && npx vitest run test/quantize.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/stake-math-tools/src/quantize.ts packages/stake-math-tools/test/quantize.test.ts
git commit -m "stake-math-tools: largest-remainder integer quantization"
```

---

### Task 5: Bucketize (zero / log / near-max)

**Files:**
- Create: `packages/stake-math-tools/test/bucketize.test.ts`
- Create: `packages/stake-math-tools/src/bucketize.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/bucketize.test.ts
import { describe, expect, it } from 'vitest';
import { bucketize } from '../src/bucketize.js';
import type { LookupRow } from '../src/types.js';

describe('bucketize', () => {
  it('places zero payouts in bucket 0; non-zero in log buckets; near-max in its own bucket', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 100, payoutCents: 0 },     // → bucket 0
      { sim: 2, weight: 200, payoutCents: 0 },     // → bucket 0
      { sim: 3, weight: 50, payoutCents: 10 },     // → low log bucket
      { sim: 4, weight: 30, payoutCents: 100 },    // → mid log bucket
      { sim: 5, weight: 10, payoutCents: 9_500 },  // → top log bucket AND near-max (cap=10000, frac=0.95)
      { sim: 6, weight: 5, payoutCents: 10_000 },  // → top log bucket AND near-max
    ];

    const result = bucketize(rows, {
      capMaxWin: 10_000,
      bucketCount: 4,
      maxReachedFraction: 0.95,
    });

    // 1 zero bucket + 4 log buckets + 1 near-max bucket = 6 entries
    expect(result.zeroBucket.indices).toEqual([0, 1]);
    expect(result.zeroBucket.totalWeight).toBe(300);

    // log buckets have 4 entries (some may be empty)
    expect(result.logBuckets).toHaveLength(4);

    // near-max bucket: rows whose payout >= 0.95 * 10_000 = 9_500
    expect(result.nearMaxBucket.indices.sort()).toEqual([4, 5]);
    expect(result.nearMaxBucket.totalWeight).toBe(15);

    // Sanity: every non-zero row appears in exactly one log bucket
    const seen = new Set<number>();
    for (const b of result.logBuckets) for (const i of b.indices) seen.add(i);
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });

  it('drops nothing — caller is expected to filter capMaxWin before calling (defense in depth)', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 1, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 50 },
    ];
    const result = bucketize(rows, { capMaxWin: 100, bucketCount: 3, maxReachedFraction: 0.95 });
    expect(result.zeroBucket.totalWeight).toBe(1);
    const totalLog = result.logBuckets.reduce((s, b) => s + b.totalWeight, 0);
    expect(totalLog).toBe(1);
  });

  it('handles a single non-zero payout (no log spread)', () => {
    const rows: LookupRow[] = [
      { sim: 1, weight: 1, payoutCents: 0 },
      { sim: 2, weight: 1, payoutCents: 500 },
    ];
    const result = bucketize(rows, { capMaxWin: 1000, bucketCount: 5, maxReachedFraction: 0.95 });
    const totalLog = result.logBuckets.reduce((s, b) => s + b.totalWeight, 0);
    expect(totalLog).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/stake-math-tools && npx vitest run test/bucketize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement bucketize.ts**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/stake-math-tools && npx vitest run test/bucketize.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/stake-math-tools/src/bucketize.ts packages/stake-math-tools/test/bucketize.test.ts
git commit -m "stake-math-tools: payout bucketization (zero/log/near-max)"
```

---

### Task 6: Stratified sampling

**Files:**
- Create: `packages/stake-math-tools/test/sample.test.ts`
- Create: `packages/stake-math-tools/src/sample.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sample.test.ts
import { describe, expect, it } from 'vitest';
import { mulberry32, weightedReservoirSample, computeQuotas, stratifiedSample } from '../src/sample.js';
import type { Bucket } from '../src/bucketize.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(0xC0FFEE);
    const b = mulberry32(0xC0FFEE);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });
  it('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe('weightedReservoirSample (A-Res)', () => {
  it('samples k items, biased toward higher weights, deterministically per seed', () => {
    // 5 candidates, weights heavily skewed toward index 4
    const weights = [1, 1, 1, 1, 1_000_000];
    const k = 1;
    const rng = mulberry32(42);
    const sampled = weightedReservoirSample([0, 1, 2, 3, 4], weights, k, rng);
    expect(sampled).toEqual([4]);
  });

  it('returns all items if k >= n (no replacement)', () => {
    const rng = mulberry32(1);
    const sampled = weightedReservoirSample([0, 1, 2], [1, 1, 1], 5, rng);
    expect(sampled.sort()).toEqual([0, 1, 2]);
  });

  it('produces stable output for a given seed (snapshot)', () => {
    const rng = mulberry32(0xC0FFEE);
    const sampled = weightedReservoirSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
                                             [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, rng);
    // Snapshot: any change in mulberry32 or A-Res will surface here.
    expect(sampled.sort()).toMatchSnapshot();
  });
});

describe('computeQuotas', () => {
  it('honors minPerBucket on non-empty non-zero buckets', () => {
    const zero: Bucket = { indices: Array(100).fill(0), totalWeight: 100, weightedPayoutSum: 0 };
    const log: Bucket[] = [
      { indices: [0, 1, 2], totalWeight: 3, weightedPayoutSum: 30 },
      { indices: [3, 4, 5, 6, 7], totalWeight: 5, weightedPayoutSum: 200 },
      { indices: [], totalWeight: 0, weightedPayoutSum: 0 },
    ];
    const nearMax: Bucket = { indices: [7], totalWeight: 1, weightedPayoutSum: 100 };

    const quotas = computeQuotas({
      zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax,
    }, { nRowsOut: 20, minPerBucket: 3, requireMaxReached: true });

    expect(quotas.logBuckets[0]).toBeGreaterThanOrEqual(3);
    expect(quotas.logBuckets[1]).toBeGreaterThanOrEqual(3);
    expect(quotas.logBuckets[2]).toBe(0); // empty bucket, zero quota
    expect(quotas.nearMaxBucket).toBeGreaterThanOrEqual(1);
    const total = quotas.zeroBucket + quotas.logBuckets.reduce((a,b) => a+b, 0) + quotas.nearMaxBucket;
    expect(total).toBe(20);
  });

  it('caps a quota at the bucket size (cannot ask for more rows than the bucket has)', () => {
    const zero: Bucket = { indices: [0], totalWeight: 1, weightedPayoutSum: 0 };
    const log: Bucket[] = [
      { indices: [1, 2], totalWeight: 2, weightedPayoutSum: 200 }, // only 2 rows here
    ];
    const nearMax: Bucket = { indices: [], totalWeight: 0, weightedPayoutSum: 0 };
    const quotas = computeQuotas({ zeroBucket: zero, logBuckets: log, nearMaxBucket: nearMax },
      { nRowsOut: 10, minPerBucket: 5, requireMaxReached: true });
    expect(quotas.logBuckets[0]).toBeLessThanOrEqual(2);
    expect(quotas.zeroBucket).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/stake-math-tools && npx vitest run test/sample.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sample.ts**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/stake-math-tools && npx vitest run test/sample.test.ts`
Expected: all tests PASS (snapshot file is auto-created on first run — that's expected; commit it).

- [ ] **Step 5: Commit**

```bash
git add packages/stake-math-tools/src/sample.ts packages/stake-math-tools/test/sample.test.ts packages/stake-math-tools/test/__snapshots__
git commit -m "stake-math-tools: stratified weighted-reservoir sampling"
```

---

### Task 7: NNLS solver (Lawson–Hanson with Tikhonov)

**Files:**
- Create: `packages/stake-math-tools/test/nnls.test.ts`
- Create: `packages/stake-math-tools/src/nnls.ts`

**Note for the implementer:** Lawson–Hanson NNLS solves `min ‖A·x − b‖² s.t. x ≥ 0`. The reference is *Solving Least Squares Problems* (Lawson & Hanson, 1974), Chapter 23. Our problem is **underdetermined** — A is m×n with m=4 (RTP, var, hit-rate, sum-of-weights) and n up to 100K. Vanilla Lawson–Hanson assumes a full-rank passive set; in our underdetermined setting the unconstrained sub-LS step has infinitely many solutions. We resolve this by adding a small Tikhonov term `ε‖x − x₀‖²` (ε ≈ 1e-8 × ‖A‖²/‖x₀‖²) which makes the problem strictly convex and the active-set algorithm well-defined. Internally this means appending an n×n identity scaled by √ε to A and a corresponding √ε·x₀ to b.

For the test we exercise small overdetermined cases (where vanilla L–H is unambiguous) plus our underdetermined case via the public `solveNNLS` wrapper that handles Tikhonov.

- [ ] **Step 1: Write the failing test**

```ts
// test/nnls.test.ts
import { describe, expect, it } from 'vitest';
import { solveNNLS } from '../src/nnls.js';

describe('solveNNLS — overdetermined (textbook cases)', () => {
  it('solves trivial scalar case', () => {
    // A = [[2]], b = [4] → x = 2
    const x = solveNNLS([[2]], [4]);
    expect(x[0]).toBeCloseTo(2, 8);
  });

  it('clips negative LS solution to zero (canonical NNLS behavior)', () => {
    // Unconstrained LS for A=[[1]], b=[-3] gives x=-3; NNLS gives x=0.
    const x = solveNNLS([[1]], [-3]);
    expect(x[0]).toBe(0);
  });

  it('returns the LS solution when it is already non-negative', () => {
    // A diag(1, 1), b = [2, 3] → x = [2, 3]
    const x = solveNNLS([[1, 0], [0, 1]], [2, 3]);
    expect(x[0]).toBeCloseTo(2, 8);
    expect(x[1]).toBeCloseTo(3, 8);
  });

  it('classic 2x3 case', () => {
    // A = [[1, 2, 3], [4, 5, 6]], b = [7, 8]
    // The unconstrained min-norm LS has x[1] negative; NNLS pins it to 0.
    const x = solveNNLS([[1, 2, 3], [4, 5, 6]], [7, 8]);
    expect(x.every((v) => v >= 0)).toBe(true);
    // Residual should be small (problem is overdetermined and degenerate)
    const r0 = x[0] + 2 * x[1] + 3 * x[2] - 7;
    const r1 = 4 * x[0] + 5 * x[1] + 6 * x[2] - 8;
    expect(Math.sqrt(r0 * r0 + r1 * r1)).toBeLessThan(0.01);
  });
});

describe('solveNNLS — underdetermined (Tikhonov-regularized)', () => {
  it('solves a 2x4 case toward a uniform prior', () => {
    // 2 equations, 4 unknowns. Many solutions exist.
    // Tikhonov prior x0 = [1, 1, 1, 1] biases toward the uniform answer.
    // A = [[1, 1, 0, 0], [0, 0, 1, 1]], b = [4, 6] → many feasible
    // x0 = [1, 1, 1, 1] picks x ≈ [2, 2, 3, 3] (uniform within each pair)
    const x = solveNNLS(
      [[1, 1, 0, 0], [0, 0, 1, 1]],
      [4, 6],
      { prior: [1, 1, 1, 1], regularization: 1e-6 },
    );
    expect(x.every((v) => v >= 0)).toBe(true);
    expect(x[0]).toBeCloseTo(2, 2);
    expect(x[1]).toBeCloseTo(2, 2);
    expect(x[2]).toBeCloseTo(3, 2);
    expect(x[3]).toBeCloseTo(3, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/stake-math-tools && npx vitest run test/nnls.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement nnls.ts**

```ts
// src/nnls.ts

export interface NNLSOptions {
  /** Tikhonov prior: regularize toward x ≈ prior. Default zero vector. */
  prior?: ReadonlyArray<number>;
  /** Tikhonov coefficient ε (default 0). When > 0, makes underdetermined problems well-posed. */
  regularization?: number;
  /** Max NNLS iterations. Default 3 × n. */
  maxIterations?: number;
  /** Tolerance for treating a value as zero. Default 1e-12. */
  tolerance?: number;
}

/**
 * Solve `min ||A x − b||² + ε ||x − prior||²  s.t.  x ≥ 0` via Lawson–Hanson NNLS.
 *
 *   A is m×n (rows = features, cols = variables). m ≪ n is permitted thanks to ε > 0.
 *
 * Algorithm: classical active-set NNLS as in Lawson & Hanson §23.3. The Tikhonov term
 * is folded in by appending √ε · I to A and √ε · prior to b — the augmented system
 * (m+n) × n is then well-posed for all passive subsets.
 */
export function solveNNLS(
  A: ReadonlyArray<ReadonlyArray<number>>,
  b: ReadonlyArray<number>,
  options: NNLSOptions = {},
): number[] {
  const m = A.length;
  const n = m === 0 ? 0 : A[0].length;
  const epsilon = options.regularization ?? 0;
  const prior = options.prior ?? new Array(n).fill(0);
  const tol = options.tolerance ?? 1e-12;
  const maxIter = options.maxIterations ?? 3 * Math.max(1, n);

  // Augment: A_aug = [A; √ε I],  b_aug = [b; √ε · prior]
  const sqrtEps = Math.sqrt(epsilon);
  const M = m + (epsilon > 0 ? n : 0);
  const Ah: number[][] = new Array(M);
  const bh: number[] = new Array(M);
  for (let i = 0; i < m; i++) {
    Ah[i] = A[i].slice();
    bh[i] = b[i];
  }
  if (epsilon > 0) {
    for (let j = 0; j < n; j++) {
      const row = new Array(n).fill(0);
      row[j] = sqrtEps;
      Ah[m + j] = row;
      bh[m + j] = sqrtEps * prior[j];
    }
  }

  return lawsonHansonNNLS(Ah, bh, n, tol, maxIter);
}

/**
 * Lawson–Hanson active-set NNLS, matrix form. Returns x ≥ 0 minimizing ||A x − b||².
 *
 * Variables:
 *   P (passive set): indices where x_i > 0, x_i is "free"
 *   Z (active set):  indices where x_i = 0, x_i is "constrained"
 *   w = Aᵀ(b − Ax) — gradient of the residual squared (negated)
 *
 * Outer loop: pick the most negative-gradient index from Z, move it to P.
 * Inner loop: solve unconstrained LS on P; if any x_i ≤ 0, perform an interpolation
 *             back to the boundary and move violators to Z; repeat.
 */
function lawsonHansonNNLS(
  A: number[][],
  b: number[],
  n: number,
  tol: number,
  maxIter: number,
): number[] {
  const m = A.length;
  const x = new Array(n).fill(0);
  const inP = new Array(n).fill(false);
  let iter = 0;

  while (iter++ < maxIter) {
    // residual r = b − A x
    const r = b.slice();
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += A[i][j] * x[j];
      r[i] -= s;
    }
    // w = Aᵀ r
    const w = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += A[i][j] * r[i];
      w[j] = s;
    }

    // Pick j* in Z with max w[j]
    let jStar = -1;
    let wMax = tol;
    for (let j = 0; j < n; j++) {
      if (!inP[j] && w[j] > wMax) {
        wMax = w[j];
        jStar = j;
      }
    }
    if (jStar < 0) break; // KKT satisfied

    inP[jStar] = true;

    // Inner loop
    let inner = 0;
    while (inner++ < maxIter) {
      // Solve LS over P only
      const pIdx: number[] = [];
      for (let j = 0; j < n; j++) if (inP[j]) pIdx.push(j);
      const sP = solveLS(A, b, pIdx);
      // Build full s
      const s = new Array(n).fill(0);
      for (let k = 0; k < pIdx.length; k++) s[pIdx[k]] = sP[k];

      let minS = Infinity;
      for (const j of pIdx) if (s[j] < minS) minS = s[j];

      if (minS > tol) {
        // All passive coords positive — accept and break inner
        for (let j = 0; j < n; j++) x[j] = s[j];
        break;
      }

      // Find α = min over j∈P with s[j]≤0 of x[j]/(x[j]−s[j])
      let alpha = Infinity;
      for (const j of pIdx) {
        if (s[j] <= tol) {
          const denom = x[j] - s[j];
          if (denom > tol) {
            const a = x[j] / denom;
            if (a < alpha) alpha = a;
          }
        }
      }
      if (!isFinite(alpha)) break; // numerical degenerate — bail

      // x = x + α (s − x), then move violators to Z
      for (let j = 0; j < n; j++) x[j] = x[j] + alpha * (s[j] - x[j]);
      for (let j = 0; j < n; j++) {
        if (inP[j] && Math.abs(x[j]) < tol) {
          x[j] = 0;
          inP[j] = false;
        }
      }
    }
  }
  return x;
}

/**
 * Solve unconstrained LS for the passive subset: argmin ‖A_P x_P − b‖² where A_P
 * is the columns of A indexed by `pIdx`. Uses normal equations (A_Pᵀ A_P) x = A_Pᵀ b
 * with Gaussian elimination — adequate for the small passive sets that arise in
 * Tikhonov-regularized NNLS (|P| ≤ m + a few extras at convergence).
 */
function solveLS(A: number[][], b: number[], pIdx: ReadonlyArray<number>): number[] {
  const m = A.length;
  const k = pIdx.length;
  if (k === 0) return [];

  // Form normal equations: G = A_Pᵀ A_P (k×k), h = A_Pᵀ b (k)
  const G: number[][] = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let a = 0; a < k; a++) {
    for (let bb = a; bb < k; bb++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += A[i][pIdx[a]] * A[i][pIdx[bb]];
      G[a][bb] = s;
      G[bb][a] = s;
    }
    let s = 0;
    for (let i = 0; i < m; i++) s += A[i][pIdx[a]] * b[i];
    G[a][k] = s;
  }

  // Gaussian elimination with partial pivoting
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(G[r][col]) > Math.abs(G[pivot][col])) pivot = r;
    if (pivot !== col) [G[col], G[pivot]] = [G[pivot], G[col]];
    if (Math.abs(G[col][col]) < 1e-14) {
      // Singular — fall back to zero for this column to keep the algorithm progressing
      G[col][col] = 1e-14;
    }
    for (let r = col + 1; r < k; r++) {
      const f = G[r][col] / G[col][col];
      for (let c = col; c <= k; c++) G[r][c] -= f * G[col][c];
    }
  }
  // Back-substitution
  const x = new Array(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = G[r][k];
    for (let c = r + 1; c < k; c++) s -= G[r][c] * x[c];
    x[r] = s / G[r][r];
  }
  return x;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/stake-math-tools && npx vitest run test/nnls.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/stake-math-tools/src/nnls.ts packages/stake-math-tools/test/nnls.test.ts
git commit -m "stake-math-tools: Lawson-Hanson NNLS with Tikhonov regularization"
```

---

### Task 8: Orchestrator — `optimizeLookupTable`

**Files:**
- Create: `packages/stake-math-tools/src/optimize-lookup.ts`
- Create: `packages/stake-math-tools/test/optimize-lookup.unit.test.ts`

The orchestrator wires phases 1–6 together. We test it here in unit form (small fixtures); end-to-end integration tests with realistic data come in Task 9.

- [ ] **Step 1: Write the failing test**

```ts
// test/optimize-lookup.unit.test.ts
import { describe, expect, it } from 'vitest';
import { optimizeLookupTable } from '../src/optimize-lookup.js';
import type { LookupRow } from '../src/types.js';

function genRows(n: number, rng: () => number, capCents: number): LookupRow[] {
  // Mix of zero, small, and occasional large payouts
  const rows: LookupRow[] = [];
  for (let i = 0; i < n; i++) {
    const u = rng();
    let payoutCents = 0;
    if (u > 0.7) payoutCents = Math.floor(rng() * 200);            // small win
    if (u > 0.95) payoutCents = Math.floor(rng() * 5_000);         // medium win
    if (u > 0.999) payoutCents = Math.floor(rng() * capCents);     // big win
    rows.push({ sim: i, weight: 1 + Math.floor(rng() * 100), payoutCents });
  }
  return rows;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('optimizeLookupTable', () => {
  it('returns exactly nRowsOut rows with integer weights summing to totalWeightOut', () => {
    const rows = genRows(2000, rng(1), 100_000);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.01,
      targetCV: 5.0, toleranceCV: 1.0,
      targetHitRate: 0.3, toleranceHitRate: 0.05,
      capMaxWin: 100_000,
      nRowsOut: 100,
    });
    expect(result.rows).toHaveLength(100);
    let sum = 0;
    for (const r of result.rows) {
      expect(Number.isInteger(r.weight)).toBe(true);
      expect(r.weight).toBeGreaterThanOrEqual(1);
      sum += r.weight;
    }
    expect(sum).toBe(100 * 1_000_000); // default totalWeightOut
  });

  it('drops rows with payout > capMaxWin from candidate pool', () => {
    const rows: LookupRow[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ sim: i, weight: 10, payoutCents: 0 })),
      { sim: 999, weight: 1, payoutCents: 999_999 }, // way above cap
    ];
    const result = optimizeLookupTable(rows, {
      targetRTP: 0, toleranceRTP: 0.01,
      targetCV: 0.1, toleranceCV: 1,
      targetHitRate: 0.05, toleranceHitRate: 0.5,
      capMaxWin: 1000,
      nRowsOut: 50,
      requireMaxReached: false,
    });
    expect(result.rows.find((r) => r.sim === 999)).toBeUndefined();
  });

  it('emits a warning and toleranceMet=false when target is infeasible', () => {
    // All payouts zero → CV=0 always; targetCV=10 is infeasible
    const rows: LookupRow[] = Array.from({ length: 200 }, (_, i) => ({
      sim: i, weight: 1, payoutCents: 0,
    }));
    const result = optimizeLookupTable(rows, {
      targetRTP: 0, toleranceRTP: 0.0001,
      targetCV: 10, toleranceCV: 0.1,
      targetHitRate: 0, toleranceHitRate: 0.0001,
      capMaxWin: 1000,
      nRowsOut: 50,
      requireMaxReached: false,
      maxIterations: 2,
    });
    expect(result.toleranceMet.cv).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('honors requireMaxReached when a near-max row exists', () => {
    const rows: LookupRow[] = [
      ...Array.from({ length: 500 }, (_, i) => ({ sim: i, weight: 100, payoutCents: 0 })),
      ...Array.from({ length: 50 }, (_, i) => ({ sim: 1000 + i, weight: 10, payoutCents: 100 })),
      { sim: 9999, weight: 1, payoutCents: 990 }, // near-max for cap=1000
    ];
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.5,    // very loose, just exercising near-max
      targetCV: 5, toleranceCV: 100,
      targetHitRate: 0.1, toleranceHitRate: 0.5,
      capMaxWin: 1000,
      maxReachedFraction: 0.95,
      requireMaxReached: true,
      nRowsOut: 100,
    });
    expect(result.toleranceMet.maxReached).toBe(true);
    expect(result.rows.find((r) => r.sim === 9999)).toBeDefined();
  });

  it('produces deterministic output for a fixed seed', () => {
    const rows = genRows(1000, rng(42), 10_000);
    const params = {
      targetRTP: 0.5, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.3, toleranceHitRate: 0.5,
      capMaxWin: 10_000,
      nRowsOut: 50,
      seed: 1234,
    };
    const a = optimizeLookupTable(rows, params);
    const b = optimizeLookupTable(rows, params);
    expect(a.rows.map((r) => r.sim)).toEqual(b.rows.map((r) => r.sim));
    expect(a.rows.map((r) => r.weight)).toEqual(b.rows.map((r) => r.weight));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/stake-math-tools && npx vitest run test/optimize-lookup.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement optimize-lookup.ts**

```ts
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
    const sampledIdx = stratifiedSample(buckets, filtered, quotas, rng);
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
    const lossSum =
      Math.pow((achieved.rtp - params.targetRTP) / params.toleranceRTP, 2) +
      Math.pow((achieved.cv - params.targetCV) / params.toleranceCV, 2) +
      Math.pow((achieved.hitRate - params.targetHitRate) / params.toleranceHitRate, 2) +
      (toleranceMet.maxReached ? 0 : 1000);

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/stake-math-tools && npx vitest run test/optimize-lookup.unit.test.ts`
Expected: 5 tests PASS. (If the determinism test wobbles due to mulberry32 reseeding inside the inner loop, fix by passing the same RNG instance through.)

- [ ] **Step 5: Commit**

```bash
git add packages/stake-math-tools/src/optimize-lookup.ts packages/stake-math-tools/test/optimize-lookup.unit.test.ts
git commit -m "stake-math-tools: optimizeLookupTable orchestrator (filter → bucketize → sample → NNLS → quantize → verify)"
```

---

### Task 9: End-to-end integration tests

**Files:**
- Create: `packages/stake-math-tools/test/optimize-lookup.integration.test.ts`

These exercise the spec's five integration scenarios against the public API. Slower (a few seconds total) but only run on `npm test`.

- [ ] **Step 1: Write the integration tests**

```ts
// test/optimize-lookup.integration.test.ts
import { describe, expect, it } from 'vitest';
import { optimizeLookupTable } from '../src/optimize-lookup.js';
import type { LookupRow } from '../src/types.js';

function makeRng(seed: number): () => number {
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
 * Generate rows where the natural population has approximately the requested
 * RTP and CV, by mixing zero-payout rows (probability 1−hitRate) with payouts
 * drawn from a log-normal scaled to hit the moments.
 */
function genTargeted(n: number, targetRTP: number, targetHitRate: number, capCents: number, seed: number): LookupRow[] {
  const rng = makeRng(seed);
  const rows: LookupRow[] = [];
  // mean payout when hit: targetRTP * 100 / targetHitRate
  const meanHit = (targetRTP * 100) / targetHitRate;
  for (let i = 0; i < n; i++) {
    const u = rng();
    let payoutCents: number;
    if (u > targetHitRate) {
      payoutCents = 0;
    } else {
      // log-normal-ish payout
      const v = rng();
      const draw = -Math.log(Math.max(1e-9, v)) * meanHit;
      payoutCents = Math.min(Math.floor(draw), capCents);
    }
    rows.push({ sim: i, weight: 1, payoutCents });
  }
  return rows;
}

describe('integration', () => {
  it('1. trivial recovery — natural distribution matches targets', () => {
    const rows = genTargeted(2000, 0.96, 0.30, 50_000, 1);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.02,
      targetCV: 5.0, toleranceCV: 2.0,
      targetHitRate: 0.30, toleranceHitRate: 0.05,
      capMaxWin: 50_000,
      nRowsOut: 200,
      requireMaxReached: false,
      maxIterations: 3,
    });
    expect(result.toleranceMet.rtp).toBe(true);
    expect(result.toleranceMet.hitRate).toBe(true);
  });

  it('2. filtered overshoot — input RTP=1.05 → optimizer pulls to 0.96', () => {
    const rows = genTargeted(3000, 1.05, 0.40, 50_000, 2);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.02,
      targetCV: 5.0, toleranceCV: 2.0,
      targetHitRate: 0.30, toleranceHitRate: 0.10,
      capMaxWin: 50_000,
      nRowsOut: 300,
      requireMaxReached: false,
      maxIterations: 3,
    });
    expect(result.toleranceMet.rtp).toBe(true);
  });

  it('3. infeasible target — graceful degradation', () => {
    const rows = genTargeted(500, 0.30, 0.10, 1000, 3);
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.30, toleranceRTP: 0.05,
      targetCV: 50, toleranceCV: 0.1,        // infeasibly large CV
      targetHitRate: 0.10, toleranceHitRate: 0.05,
      capMaxWin: 1000,
      nRowsOut: 100,
      requireMaxReached: false,
      maxIterations: 2,
    });
    expect(result.toleranceMet.cv).toBe(false);
    expect(result.warnings.some((w) => /CV/i.test(w))).toBe(true);
  });

  it('4. near-max representation — top-end row is in output', () => {
    const rng = makeRng(4);
    const rows: LookupRow[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        sim: i,
        weight: 1,
        payoutCents: rng() < 0.7 ? 0 : Math.floor(rng() * 50_000),
      });
    }
    rows.push({ sim: 9999, weight: 1, payoutCents: 990_000 }); // near-max of 1_000_000
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.96, toleranceRTP: 0.5,
      targetCV: 3, toleranceCV: 100,
      targetHitRate: 0.30, toleranceHitRate: 0.5,
      capMaxWin: 1_000_000,
      maxReachedFraction: 0.95,
      requireMaxReached: true,
      nRowsOut: 100,
      maxIterations: 2,
    });
    expect(result.achieved.maxPayout).toBeGreaterThanOrEqual(0.95 * 1_000_000);
  });

  it('5. smoke at scale — 1M synthetic rows in under 30s', () => {
    const rng = makeRng(5);
    const rows: LookupRow[] = new Array(1_000_000);
    for (let i = 0; i < 1_000_000; i++) {
      const u = rng();
      let p = 0;
      if (u > 0.7) p = Math.floor(rng() * 200);
      if (u > 0.97) p = Math.floor(rng() * 5_000);
      if (u > 0.999) p = Math.floor(rng() * 50_000);
      rows[i] = { sim: i, weight: 1 + Math.floor(rng() * 10), payoutCents: p };
    }

    const t0 = performance.now();
    const result = optimizeLookupTable(rows, {
      targetRTP: 0.5, toleranceRTP: 0.2,
      targetCV: 3, toleranceCV: 5,
      targetHitRate: 0.30, toleranceHitRate: 0.1,
      capMaxWin: 50_000,
      nRowsOut: 1000,
      requireMaxReached: false,
      maxIterations: 2,
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(30_000);
    let sum = 0;
    for (const r of result.rows) sum += r.weight;
    expect(sum).toBe(1000 * 1_000_000);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `cd packages/stake-math-tools && npx vitest run test/optimize-lookup.integration.test.ts`
Expected: 5 tests PASS. The smoke test takes 5–20s; if it times out, increase `vitest.config.ts` `testTimeout`.

- [ ] **Step 3: Commit**

```bash
git add packages/stake-math-tools/test/optimize-lookup.integration.test.ts
git commit -m "stake-math-tools: end-to-end integration tests"
```

---

### Task 10: Public API + monorepo wiring

**Files:**
- Create: `packages/stake-math-tools/src/index.ts`
- Modify: `packages/stake-math-tools/package.json` (add `typecheck` is already there; nothing else)
- Modify: `package.json` (root) — add `typecheck` workspace consistency

- [ ] **Step 1: Write index.ts**

```ts
// src/index.ts
export { optimizeLookupTable } from './optimize-lookup.js';
export type {
  LookupRow,
  OptimizeParams,
  OptimizeResult,
  OptimizeAchieved,
  ToleranceMet,
} from './types.js';

// Lower-level pieces — exposed so callers can build alternative pipelines or test in isolation.
export { computeMetrics, isNearMax } from './metrics.js';
export { bucketize } from './bucketize.js';
export type { Bucket, BucketizeResult, BucketizeOptions } from './bucketize.js';
export { mulberry32, weightedReservoirSample, computeQuotas, stratifiedSample } from './sample.js';
export type { Quotas, QuotaInput, QuotaParams } from './sample.js';
export { solveNNLS } from './nnls.js';
export type { NNLSOptions } from './nnls.js';
export { quantizeWeights } from './quantize.js';
```

- [ ] **Step 2: Verify typecheck across the workspace**

Run: `cd /Users/mrphelko/Documents/repo/energy8-platform-game-sdk && npm run typecheck`
Expected: PASS for stake-math-tools (game-sdk and stake-bridge typecheck independently — unchanged).

- [ ] **Step 3: Run the full test suite**

Run: `cd packages/stake-math-tools && npm test`
Expected: all unit + integration tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/stake-math-tools/src/index.ts
git commit -m "stake-math-tools: public exports"
```

- [ ] **Step 5: Cross-reference stake-math-tools from the stake-bridge README**

Use the Edit tool on `packages/stake-bridge/README.md`. Find the line `## License` and replace it with:

```markdown
## Building a lookup table (force matrix)

For Stake Engine deployments that require a pre-built lookup table, use the
companion package [`@energy8platform/stake-math-tools`](../stake-math-tools)
to compress raw simulation output into a target-RTP / target-volatility
weighted table. It is a node-only dev-time tool, not bundled into the game.

## License
```

- [ ] **Step 6: Final commit**

```bash
git add packages/stake-bridge/README.md
git commit -m "stake-bridge: cross-reference stake-math-tools in README"
```

---

## Spec coverage check

Walking through the spec's required behaviors against the tasks:

| Spec requirement | Implemented in |
|---|---|
| Public function `optimizeLookupTable(rows, params)` | Task 8, exported in Task 10 |
| `Iterable<LookupRow>` input (array or generator) | Task 8 (`for…of` over `rowsIn`) |
| Six-phase pipeline | Task 8 orchestrator |
| Phase 1 — filter + source statistics + early infeasibility warnings | Task 8, helper from Task 3 |
| Phase 2 — bucketize zero / log / near-max | Task 5 |
| Phase 3 — quotas + weighted reservoir + near-max forcing | Task 6 |
| Phase 4 — NNLS with Tikhonov + sum row + μ̂ fixed-point | Tasks 7 + 8 |
| Phase 5 — largest-remainder quantization, `wᵢ ≥ 1`, exact sum | Task 4 |
| Phase 6 — verify + retry up to `maxIterations`, return best-effort with warnings, never throw on tolerance miss | Task 8 |
| Defaults (`totalWeightOut`, `seed`, `bucketCount`, `minPerBucket`, `maxIterations`, `maxReachedFraction`) | Task 8 `DEFAULTS` block |
| Determinism via seed | Task 6 (`mulberry32`), Task 8 (`seed + iter`); covered by determinism test in Task 8 |
| Five integration scenarios | Task 9 |
| Tooling — vitest, scoped to this package only | Task 1 |
| TDD discipline (test-first per phase) | Tasks 3–8 each lead with failing test |
| Lawson–Hanson textbook test cases | Task 7 |
| BigInt accumulators in metrics | Task 3 |

Coverage is complete.

## Notes for the implementer

- **Unused imports:** `solveLS` is internal to `nnls.ts`. Don't export it.
- **The mulberry32 implementation appears in two test files (sample, integration)** plus once in `sample.ts`. The duplication in tests is intentional (skill: explicit code in each test is easier to read than shared helpers). Don't refactor it out — the tests are exposition, not production code.
- **NNLS underdetermined caveat:** if test 4 in Task 7 (the 2x4 underdetermined case) shows poor convergence at `regularization: 1e-6`, raise to `1e-4`. The Tikhonov ε is a knob — small enough not to bias the solution, large enough to make the LS subproblem well-conditioned.
- **CV row in `optimize-lookup.ts` Task 8 Step 3:** the row uses `(payout − μ̂)²` as the feature. This makes the variance term linear in `w` *given* `μ̂`, which is why we need the fixed-point iteration on `μ̂`. If the iteration doesn't converge in 5 inner steps, accept the latest result and move on — phase 6's outer loop will retry if the result is off-tolerance.
- **The `1e-6` "tolerance" used in the sum-row weight in Task 8 Step 3** is **not** a user-facing tolerance — it's a near-zero number used to make the sum row dominate the loss (effectively a hard equality). Don't surface it as a parameter.
