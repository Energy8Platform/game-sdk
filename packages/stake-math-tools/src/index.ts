// src/index.ts
export { optimizeLookupTable } from './optimize-lookup.js';
export { buildTieredLookup } from './tiered.js';
export type {
  LookupRow,
  OptimizeParams,
  OptimizeResult,
  OptimizeAchieved,
  ToleranceMet,
  StakeReport,
  TopKShare,
  HitRateBucket,
  RefinementStats,
} from './types.js';
export { computeStakeReport, detectHitRateGaps } from './stake-report.js';
export { transformJsonlZst } from './transform-jsonl-zst.js';
export type {
  TransformJsonlZstParams,
  TransformJsonlZstResult,
  LineMapper,
} from './transform-jsonl-zst.js';

// Lower-level pieces — exposed so callers can build alternative pipelines or test in isolation.
export { computeMetrics, isNearMax } from './metrics.js';
export { bucketize } from './bucketize.js';
export type { Bucket, BucketizeResult, BucketizeOptions } from './bucketize.js';
export { mulberry32, weightedReservoirSample, computeQuotas, stratifiedSample } from './sample.js';
export type { Quotas, QuotaInput, QuotaParams } from './sample.js';
export { solveNNLS } from './nnls.js';
export type { NNLSOptions } from './nnls.js';
export { solveQP, projectSimplex } from './qp.js';
export type { QPOptions } from './qp.js';
export { quantizeWeights } from './quantize.js';
