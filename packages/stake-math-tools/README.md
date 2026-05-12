# @energy8platform/stake-math-tools

Node-only dev-time utilities for building [Stake Engine](https://stake-engine.com/docs) **lookup tables (force matrices)** from raw simulation output. Compresses millions of source simulations into a small weighted table that passes Stake's publish-time validation gates (Liability Limits, Gaps in Hit Rate Table, Unique Events). Companion to [`@energy8platform/stake-bridge`](../stake-bridge).

## Why

Stake Engine games ship a pre-built weighted lookup table: each row is `(sim_id, weight, payout_cents)` and the RGS samples a row at runtime to decide each round's outcome. The math team's job is to compress millions of raw simulations down to a much smaller weighted table whose aggregate distribution still hits the design's target **RTP / volatility / hit-rate** under a hard `capMaxWin` ceiling, **and** passes Stake's risk-management checks.

This package does that compression in one call.

## Two algorithms, one entry point

```
optimizeLookupTable(rows, params)
       │
       ├─ algorithm: 'tiered'  (default, recommended for Stake)
       │   └─ tier rows by payout magnitude; cap+large rows get weight 1;
       │      small rows get weight W calibrated to preserve cap rate.
       │      Three refinement passes — composition (hit-rate),
       │      RTP-aware partition (mean), Σ-preserving 2-swap (variance).
       │      Stake-Liability-safe by design.
       │
       └─ algorithm: 'nnls'    (legacy, exact target-fitting)
           └─ Lawson–Hanson NNLS over sampled candidates.
              Hits RTP/CV/hit-rate exactly but tends to concentrate
              weight on few rows — typically fails Stake's
              "Within Liability Limits" check on volatile games.
```

The default is `'tiered'`. Pick `'nnls'` only when Stake-compatibility is not a concern (custom RGS, internal tooling, etc.).

## Architecture (tiered, default)

```
raw simulations (1M–10M rows)                          lookup table (10K–100K rows)
        │                                                       ▲
        ▼                                                       │
filter (payout ≤ capMaxWin)                                     │
        │                                                       │
        ▼                                                       │
classify by payout multiplier:                                  │
  cap   (pm ≥ capPmThreshold)        weight = 1                 │
  large (largePm ≤ pm < cap)         weight = 1   ◄── rare      │
  small (zero + bulk)                weight = W                 │
        │                                                       │
        ▼                                                       │
sample composition biased by targetHitRate                      │
(n_nonzero / n_zero proportion in small tier)                   │
        │                                                       │
        ▼                                                       │
RTP-aware partition of non-zero small:                          │
   solve  n_high·μ_high + n_low·μ_low = n_B · μ_target          │
   then stratified log-payout sample within each side           │
        │                                                       │
        ▼                                                       │
refineRtpBySwap  — single-row in↔out swaps close the residual   │
                    RTP gap within toleranceRTP budget          │
        │                                                       │
        ▼                                                       │
refineCvBySwap   — Σ-preserving 2-swaps adjust Σ payout² toward │
                    target without disturbing the RTP we just   │
                    achieved (Σ-drift bounded by toleranceRTP)  │
        │                                                       │
        ▼                                                       │
fillStakeRangeGaps — for each Stake distribution range up to    │
                     maxPayout that's empty but source has rows,│
                     swap in a source row. Prevents "Gaps in    │
                     the Hit Rate Table" rejection.             │
        │                                                       │
        ▼                                                       │
W = n_high·(1 − target_cap_rate) / (n_small · target_cap_rate)  │
        │                                                       │
        ▼                                                       │
compute stakeReport (top-K, distribution, unique events) ───────┘
```

Determinism is preserved through a single `seed` parameter that threads every RNG call.

## Install

The package is a monorepo workspace member; consumers inside the repo just import it. It is not published to npm.

## Quick start

```ts
import { optimizeLookupTable, type LookupRow } from '@energy8platform/stake-math-tools';

// 1. Parse simulation dump (CSV → array). No CSV parser is included on purpose —
//    the math team's pipeline already has one. The input is just Iterable<LookupRow>.
const rows: LookupRow[] = parseCsv('./sim_output.csv');

// 2. Compress.
const result = optimizeLookupTable(rows, {
  targetRTP: 0.96,        toleranceRTP: 0.005,
  targetCV: 8.0,          toleranceCV: 1.0,
  targetHitRate: 0.30,    toleranceHitRate: 0.01,
  capMaxWin: 5_000_000,   // payout cents (50000.00x bet)
  nRowsOut: 100_000,

  // Stake-tuning knobs (recommended for production):
  largePmThreshold: 50,   // pm ≥ 50 → large tier (weight=1). Lower = lower concentration,
                          //   slower convergence. 50–500 is a typical range.
});

// 3. Inspect.
console.log(result.achieved);          // { rtp, cv, hitRate, maxPayout, totalWeight }
console.log(result.toleranceMet);      // booleans per target
console.log(result.maxRowRtpShare);    // top-1 RTP share — Stake Liability indicator
console.log(result.stakeReport);       // full Stake-style report (see below)
if (result.warnings.length) console.warn(result.warnings);

// 4. Write rows out in the format Stake expects: (sim_id, weight, payoutCents)
writeCsv('./lookUpTable_BASE_0.csv', result.rows);
```

## Public API

| Export | Purpose |
|---|---|
| **`optimizeLookupTable(rows, params)`** | Main entry. Dispatches to tiered or nnls. |
| `buildTieredLookup(rows, params)` | Tier-based algorithm directly (bypasses dispatcher). |
| `computeStakeReport(rows, achieved, betCostCents)` | Compute Stake-style report from a built table. |
| `detectHitRateGaps(distribution)` | Find intermediate empty buckets in the hit-rate table. |
| `computeMetrics(rows)` | Weighted RTP / CV / hit-rate / maxPayout. BigInt-safe accumulators. |
| `bucketize(rows, opts)` | Zero / log-spaced / near-max payout partition. |
| `mulberry32(seed)` | Tiny deterministic PRNG. |
| `weightedReservoirSample(indices, weights, k, rng)` | Algorithm A-Res. |
| `solveNNLS(A, b, opts?)` | Lawson–Hanson NNLS with Tikhonov regularization. |
| `solveQP(A, b, opts)` | FISTA + simplex projection (alternative QP solver). |
| `quantizeWeights(weights, total)` | Largest-remainder, `wᵢ ≥ 1`, exact `Σ = total`. |

Full types in [`src/types.ts`](./src/types.ts). Internal helpers (`lawsonHansonNNLS`, `solveLS`, …) are not exported.

## `optimizeLookupTable(rows, params)`

### Required

| Param | Type | Description |
|---|---|---|
| `targetRTP` | `number` | LUT-RTP target (`Σ(w·payout) / (Σw · betCostCents)`). E.g. `0.96`. For buy-bonus modes, set to `gameRtp × cost`. |
| `toleranceRTP` | `number` | Tight tolerance drives refinement-loop precision. E.g. `0.001`. |
| `targetCV` | `number` | Coefficient of variation (volatility). |
| `toleranceCV` | `number` | Exits CV refinement when gap drops below this. |
| `targetHitRate` | `number` | Fraction of weighted output landing on `payout > 0`. |
| `toleranceHitRate` | `number` | |
| `capMaxWin` | `number` | Hard cap in payout cents. Rows above are dropped. |
| `nRowsOut` | `number` | Exact output row count. |

### Tier-based knobs (recommended for Stake)

| Param | Default | Description |
|---|---|---|
| `algorithm` | `'tiered'` | `'tiered'` or `'nnls'`. |
| `capPmThreshold` | `0.95 × maxPm` | pm ≥ this → cap tier (weight 1). |
| `largePmThreshold` | `undefined` | pm in `[largePm, cap)` → large tier (weight 1). Set this to **lower the top-K RTP share** and improve Stake-Liability margin. Typical: 50–500. |
| `largeTarget` | natural rate | Effective P(cap+large) in output. Override with Stake's per-tier limits if needed. |
| `betCostCents` | `100` | Bet cost (1 bet = 100 cents). Used for pm = payoutCents / betCostCents. |
| `ensureRangeCoverage` | `true` | Run a 4th refinement pass that guarantees every Stake distribution range up to actual maxPayout has ≥ 1 output row when source has rows in it. Prevents "Gaps in the Hit Rate Table" rejection. Set to `false` to disable. |

### Output sizing

| Param | Default | Description |
|---|---|---|
| `requireMaxReached` | `true` | Force ≥ 1 output row close to `capMaxWin`. |
| `maxReachedFraction` | `0.95` | What counts as "close". |
| `totalWeightOut` | `nRowsOut × 1_000_000` | Sum of integer output weights. |
| `seed` | `0xC0FFEE` | Deterministic seed for all RNG. |

### NNLS-only knobs

| Param | Default | Description |
|---|---|---|
| `maxIterations` | `5` | Expand-and-retry attempts on tolerance miss. |
| `bucketCount` | `100` | Log-buckets between min-nonzero and cap. |
| `minPerBucket` | `3` | Min sample slots per non-empty non-zero bucket. |
| `maxRowRtpShare` | `0.05` | Per-row cap on RTP contribution (iterative cap-and-resolve). |
| `maxWeightPerRow` | `10` | Per-row weight ≤ N × uniform-prior. |

### Returns

```ts
{
  rows: LookupRow[],                  // exactly nRowsOut rows; sim_id preserved
  achieved: {
    rtp, cv, hitRate, maxPayout, totalWeight
  },
  toleranceMet: {
    rtp, cv, hitRate, maxReached,
    rtpConcentration, weightCap        // NNLS-only constraints
  },
  maxRowRtpShare: number,              // largest single-row RTP fraction
  maxWeightRatio: number,              // max weight / uniform-prior
  warnings: string[],                  // human-readable issues (gaps, target misses, …)
  stakeReport: {                       // Stake-publish-UI-equivalent metrics
    payoutMultMax,                     // ≡ Stake's "Payout Mult"
    baseStd,                           // ≡ Stake's "Base STD"
    prob5K, prob10K,                   // ≡ "Within 5K/10K Probability Limits"
    topKShare: [{k: 1, share}, …],     // top-1/5/10/100 RTP shares
    hitRateDistribution: HitRateBucket[],  // 16-bucket pm table mirroring Stake's UI
    uniqueEvents: number,              // distinct payoutCents — ≡ "Insufficient Unique Events"
    betCostCents
  }
}
```

Never throws on tolerance miss — returns the best-effort result with `warnings`. Only throws when the filtered input has fewer than `nRowsOut` rows.

Determinism: same `(rows, params)` → bit-identical output.

## Hit-rate distribution table

`result.stakeReport.hitRateDistribution` mirrors what Stake Engine shows in the publish UI. 16 payout-multiplier buckets:

```
[0, 0.1)   [0.1, 1)   [1, 2)   [2, 5)   [5, 10)   [10, 20)
[20, 50)   [50, 100)  [100, 200)  [200, 500)
[500, 1000)  [1000, 2000)  [2000, 5000)  [5000, 10000)
[10000, 20000)  [20000, ∞)
```

For each bucket: `count` (rows in range), `effectiveHitRate` (Σ weight in range / total weight).

`detectHitRateGaps(distribution)` returns the **intermediate** empty buckets (sandwiched between non-empty ones) — these are what Stake's "Gaps in the Hit Rate Table" check flags. Empty buckets at the tail (above the highest non-empty bucket) are natural and not flagged.

The optimizer **proactively prevents** intermediate gaps via the `ensureRangeCoverage` pass (default on for tier-based): after RTP+CV refinement, any empty intermediate bucket gets a row swapped in from source. If a range can't be filled (source has no rows in that pm range), a warning is emitted — that's a game-design issue your simulation needs to address.

## Stake publish-UI mapping

| Stake UI metric | `result.stakeReport` field | Notes |
|---|---|---|
| Payout Mult | `payoutMultMax` | max payout / bet |
| Base STD | `baseStd` | stddev in bet units |
| Within 5K/10K Probability Limits | `prob5K`, `prob10K` | typically 0 for non-progressive games |
| Within Liability Limits | `topKShare[0]` (top-1) | usually < 0.05 with `largePmThreshold` set |
| Within Risk Limits | (compute from `baseStd × betCost × maxBet`) | |
| Hit-Rate Distribution table | `hitRateDistribution` | full match by range |
| Insufficient Unique Events | `uniqueEvents` | distinct payoutCents in output |
| Gaps in Hit Rate Table | `detectHitRateGaps(...)` returns `[]` | tail empties are natural |

## How tolerance flows

Both refinement passes derive their per-iteration Σ-drift budget from `params.toleranceRTP` so the user's `tolerance*` values **actually drive the precision**:

- `refineRtpBySwap` uses `0.5 × toleranceRTP × T × 100 / W` cents of Σ-drift budget.
- `refineCvBySwap` uses the other `0.5 × toleranceRTP × …`, and exits when `|Σ²_achieved − Σ²_target| ≤ 2 × targetCV × mean² × T × toleranceCV / W`.

Tighten `toleranceRTP` for sub-percent precision; loosen `toleranceCV` to let CV refinement exit earlier when the source distribution can't reach the target.

## Scripts

```bash
npm test          # vitest run — full suite (~15s)
npm run typecheck # tsc --noEmit
```

## Design history

- [`docs/superpowers/specs/2026-05-08-stake-lookup-optimizer-design.md`](../../docs/superpowers/specs/2026-05-08-stake-lookup-optimizer-design.md) — original NNLS-based design.
- Subsequent commits added the tiered algorithm in response to Stake's "Within Liability Limits" rejection of the NNLS-concentrated output. The tier-based approach is what Stake's reference implementations use; we converged independently on the same algorithm via empirical iteration.

## License

MIT
