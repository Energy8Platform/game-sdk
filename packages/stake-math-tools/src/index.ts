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
