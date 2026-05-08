# Stake lookup-table optimizer — design

**Status**: design approved (2026-05-08), ready for implementation plan.

## Problem

The Stake math SDK produces a raw simulation dump: millions of independent rounds, each with a probability/weight and a payout multiplier (in cents — payout × 100, integer). To ship a real game we need to compress that dump into a much smaller weighted **lookup table** (a.k.a. force matrix) that the RGS samples at runtime, while hitting the math team's targets — RTP, volatility (CV), hit-rate — within a tolerance, and respecting a hard `capMaxWin` ceiling.

There is no off-the-shelf utility in this repo that does this. Hand-tuning a lookup table by trial and error is what the math person currently has to do.

## Goal

A pure TypeScript library function `optimizeLookupTable(rows, params)` that takes the raw simulation dump and returns a weighted subset of size `nRowsOut` whose aggregate distribution matches the targets. Node-only, dev-time tool — runs in math-tuning scripts, never bundled into the game.

## Non-goals

- CSV / file I/O — caller parses input and writes output. The function takes `Iterable<LookupRow>`, returns an array.
- Multi-mode / buy-bonus splitting — caller invokes the optimizer once per mode (BASE, BONUS, …).
- Continuous (float) output weights — output weights are always integers (Stake's `force_*.csv` format).
- Browser usage — this is a Node-only build-time tool.

## Package layout

New monorepo package, **private** (not published to npm):

```
packages/stake-math-tools/
  src/
    index.ts                  // public exports
    types.ts                  // LookupRow, OptimizeParams, OptimizeResult
    optimize-lookup.ts        // orchestrator: filter → bucketize → sample → solve → quantize → verify
    metrics.ts                // RTP, CV, hit-rate, near-max — formulas in one place
    bucketize.ts              // payout buckets (zero / log / near-max)
    sample.ts                 // stratified weighted-reservoir sampling
    nnls.ts                   // Lawson–Hanson NNLS solver
    quantize.ts               // largest-remainder integer quantization
  test/
    metrics.test.ts
    bucketize.test.ts
    sample.test.ts
    nnls.test.ts
    quantize.test.ts
    optimize-lookup.integration.test.ts
  package.json                // private:true, ESM, vitest as devDep
  tsconfig.json
```

Why a separate package, not extending `stake-bridge`: `stake-bridge` is **runtime** code that ships in the game bundle. This optimizer is **dev-time** code, Node-only, and would balloon the bridge bundle. Keeping them separate also makes dependency direction clean (`stake-math-tools` depends on nothing from the bridge).

## Public API

```ts
export interface LookupRow {
  sim: number;             // simulation number — opaque identifier, preserved on output
  weight: number;          // input weight, integer (typically large — e.g. 1.99e11)
  payoutCents: number;     // payout multiplier × 100, integer (≥ 0)
}

export interface OptimizeParams {
  // Targets — each with a tolerance (admissible deviation, ± in absolute units)
  targetRTP: number;             // e.g. 0.96
  toleranceRTP: number;          // e.g. 0.0005

  targetCV: number;              // coefficient of variation, e.g. 8.0
  toleranceCV: number;           // e.g. 0.1

  targetHitRate: number;         // fraction of weighted spins with payout > 0, in [0, 1]
  toleranceHitRate: number;

  // Hard cap — rows with payoutCents > capMaxWin are dropped before sampling
  capMaxWin: number;

  // Near-max constraint
  requireMaxReached?: boolean;   // default true: at least one row with payout ≥ maxReachedFraction × cap
  maxReachedFraction?: number;   // default 0.95

  // Output sizing
  nRowsOut: number;              // exact size of the returned table
  totalWeightOut?: number;       // sum of integer output weights. default = nRowsOut × 1_000_000

  // Determinism / control
  seed?: number;                 // sampling RNG seed. default = 0xC0FFEE
  maxIterations?: number;        // expand-and-retry attempts on tolerance miss. default = 5
  bucketCount?: number;          // number of log-buckets between min-nonzero and capMaxWin. default = 100
  minPerBucket?: number;         // minimum sample slots per non-empty non-zero bucket. default = 3
}

export interface OptimizeResult {
  rows: LookupRow[];             // exactly nRowsOut entries; sim is taken from the chosen input rows
  achieved: {
    rtp: number;
    cv: number;
    hitRate: number;
    maxPayout: number;
    totalWeight: number;
  };
  toleranceMet: {
    rtp: boolean;
    cv: boolean;
    hitRate: boolean;
    maxReached: boolean;
  };
  warnings: string[];
}

export function optimizeLookupTable(
  rows: Iterable<LookupRow>,
  params: OptimizeParams,
): OptimizeResult;
```

The function is **synchronous** — `Iterable<LookupRow>` is fine for the realistic input sizes (≤ 10M rows fits in memory; 10M × ~24 bytes ≈ 240 MB). Truly streaming I/O is a future extension behind a separate entry point if it ever becomes necessary.

## Algorithm — six phases

```
input rows ──► [1] filter + stats ──► [2] bucketize ──► [3] stratified sample
                                                              │
                                                              ▼
                                                        candidate rows (size N)
                                                              │
                                                              ▼
                          ◄── verify ◄── [5] quantize ◄── [4] NNLS solve
                                │
                       (loop on tolerance miss, up to maxIterations)
```

### Phase 1 — filter + source statistics

Single pass over input. Drop rows with `payoutCents > capMaxWin`. Accumulate (using `BigInt` to be safe against overflow on weight × payout × payout):

- `totalWeightIn`
- `Σ w·payout` → source RTP
- `Σ w·payout²` → source variance / CV
- `Σ_{payout>0} w` → source hit-rate
- `maxPayout`

These let the optimizer detect impossible-target situations early (e.g. `sourceRTP < targetRTP − toleranceRTP`) and emit a warning before doing the work.

### Phase 2 — bucketize

Partition the **filtered** input into:

- `bucket[0]` — `payout == 0`
- `bucket[1..K]` — log-spaced buckets between min-nonzero and `capMaxWin`
- `bucket[K+1]` — "near-max" bucket: `payout ≥ maxReachedFraction × capMaxWin` (overlaps with the top log-bucket; tracked separately so we can guarantee its representation in phase 3)

Each bucket stores the list of row indices into the filtered array plus its total weight. Empty buckets are dropped silently.

### Phase 3 — stratified sampling

Compute per-bucket quotas summing to `nRowsOut`:

1. Each non-empty non-zero bucket gets a floor of `minPerBucket` slots (default 3).
2. The near-max bucket gets at least 1 slot when `requireMaxReached` is true and the bucket is non-empty.
3. Remaining slots are distributed across buckets proportional to **bucket weight × bucket mean payout²** — the variance-contribution heuristic, which preserves long-tail shape better than weight-only proportional sampling.
4. The zero-bucket absorbs the rounding remainder (in practice it dominates anyway).

Within each bucket, pick rows by **weighted reservoir sampling (A-Res)** with the seeded RNG so the result is bit-reproducible at a given seed.

After phase 3 we have `N = nRowsOut` candidate rows ready for weight optimization.

### Phase 4 — NNLS weight solve

Solve a small constrained quadratic problem:

minimize ‖A·w − b‖² subject to wᵢ ≥ 0

with rows of A (one per target), each scaled by `1/tolerance` so the loss is normalized to "tolerance-units":

| feature row | value per column i | target b |
|---|---|---|
| RTP | `payoutᵢ` | `targetRTP × totalWeightOut × 100` |
| CV  | `(payoutᵢ − μ̂)²` | `(targetCV × μ̂)² × totalWeightOut` |
| hit-rate | `1` if `payoutᵢ > 0` else `0` | `targetHitRate × totalWeightOut` |
| sum  | `1` | `totalWeightOut` |

`μ̂` (mean payout under the chosen weights) appears non-linearly in the CV row. Resolved by **fixed-point iteration**: start with `μ̂ = targetRTP × 100`, solve NNLS, recompute `μ̂` from the new `w`, repeat. Three to five iterations are typically enough; cap at 10.

Solver: **Lawson–Hanson NNLS** (~150–300 lines of TypeScript). Float64 internally — accuracy is plenty given quantization happens next anyway. If on production-scale inputs (N ≈ 100K) NNLS proves too slow, swap in projected gradient descent — left as a future extension behind the same `solve()` interface; not implemented now.

### Phase 5 — integer quantization (largest-remainder)

NNLS returns `wᵢ ∈ ℝ⁺`. Convert to integers preserving `Σ wᵢ = totalWeightOut` **and** `wᵢ ≥ 1` (so the output keeps exactly `nRowsOut` rows, as the API contract requires):

```
floors = wᵢ.map(w => max(1, floor(w)))
remainders = wᵢ.map((w, i) => max(0, w - floors[i]))
deficit = totalWeightOut - sum(floors)
   if deficit ≥ 0: hand the missing 1's to rows with the largest remainders
   if deficit < 0: take 1's from the rows with the largest current weight (never below 1) until balanced
```

The `wᵢ ≥ 1` floor introduces a small bias against rows whose NNLS weight was effectively zero; the bias is bounded by `(N − active) / totalWeightOut` which at the chosen `totalWeightOut = N × 10⁶` default is ≤ 1 ppm and negligible for RTP/CV. If phase 6 detects this bias actually pushed a target outside tolerance, the retry expands the sample so fewer near-zero rows are picked.

### Phase 6 — verify + retry

Compute `achieved.{rtp, cv, hitRate, maxPayout}` on the quantized rows.

- If all targets are within tolerance → return.
- Otherwise, retry from phase 3 with **expanded quotas** (boost the buckets that pulled in the wrong direction by 10%, capped at total bucket weight) and seed `seed + iteration` so the resample is independent of the previous attempt.
- After `maxIterations` retries, return the best-effort result with `toleranceMet.* = false` and an explanatory `warnings` entry per missed target. **Never throw** — the caller decides what to do.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| NNLS too slow at N ≈ 100K | medium | Bench in implementation; if >10s, swap to projected gradient descent under the same `solve()` interface. Not done preemptively. |
| BigInt arithmetic slows the hot loop | low | BigInt only for phase-1/2 accumulators; phase 4 NNLS uses Float64. |
| CV target and hit-rate target conflict on a given input | medium | Loss is tolerance-normalized so neither target swamps the other. Truly infeasible cases surface as `toleranceMet=false` + warning rather than throwing. |
| Near-max bucket empty | low | When `requireMaxReached=true` and the bucket is empty, emit a warning and proceed without that constraint. |
| 10M-row input doesn't fit as `Iterable` consumed twice | low | Realistic input fits. If a true single-pass case appears, add a `streamingOptimize` entry point later — out of scope here. |

## Defaults (chosen, not configurable beyond the API)

| Parameter | Default | Reasoning |
|---|---|---|
| `totalWeightOut` | `nRowsOut × 1_000_000` | ~1 ppm precision on weights, not tied to a Stake-specific constant |
| `minPerBucket` | 3 | Enough to keep tail shape; not so high it crowds out the bulk |
| `bucketCount` | 100 | Log-buckets at this count cover 6 decades of payout with ≥ 16 buckets per decade |
| `seed` | `0xC0FFEE` | Reproducible by default; caller overrides if needed |
| `maxIterations` | 5 | Enough for the retry loop to recover from quota miscalibration without hiding real infeasibility |
| `maxReachedFraction` | 0.95 | "Reached the cap" in the player's eyes — close enough that the top-end is visibly possible |

## Testing

**Tooling**: vitest, scoped to this package (added as a devDependency in `stake-math-tools` only — not propagated to other workspaces).

**Unit tests** (one file per module):

- `metrics.ts` — synthetic small input with hand-computed RTP / CV / hit-rate, asserting the formulas.
- `bucketize.ts` — log-uniform input of 1000 rows, assert bucket boundaries and that zero / near-max buckets are tracked separately.
- `sample.ts` — fixed seed → bytewise-stable indices snapshot; quotas honored; reservoir respects bucket weights.
- `nnls.ts` — Lawson–Hanson textbook test cases with known answers; degenerate input (all payouts equal → CV row is zero).
- `quantize.ts` — `Σ` invariant on 10K random distributions; deficit-by-remainder is correct when ties exist.

**Integration tests** (through `optimizeLookupTable`):

1. **Trivial recovery**: 1000 rows generated to match RTP=0.96 / CV=8.0 → optimizer recovers the targets within tolerance.
2. **Filtered overshoot**: 100K rows with native RTP=1.05; after `capMaxWin` filter + optimize, achieved RTP within tolerance, no warnings.
3. **Infeasible target**: targetCV=20 on input with achievable max ≈ 5 → `toleranceMet.cv=false`, descriptive warning, no throw.
4. **Near-max representation**: cap = 1_000_000, most input rows < 100K; assert `achieved.maxPayout ≥ 0.95 × cap`.
5. **Smoke at scale**: 1M synthetic rows; one CI run; assert runtime < 10s and `Σ weight === totalWeightOut`.

**TDD discipline**:

- Phases 1, 2, 5, 6 — strictly test-first (deterministic, easy to specify).
- Phase 4 (NNLS) — test-first against textbook cases; implementation transcribed from Lawson–Hanson, not rederived.
- Phase 3 (sampling) — test-first via fixed seed + snapshot, not statistical-distribution assertions.

## Open questions for implementation time

None blocking. The design is closed; implementation can start.
