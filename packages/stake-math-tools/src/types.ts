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

  /** Maximum fraction of total RTP that any single output row may contribute.
   *  Stake Engine's "Within Liability Limits" check fails when one row dominates RTP.
   *  Default 0.05 (5%). Set to 1.0 to disable.
   */
  maxRowRtpShare?: number;
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
  /** True if no output row contributes more than maxRowRtpShare of total RTP. */
  rtpConcentration: boolean;
}

export interface OptimizeResult {
  rows: LookupRow[];
  achieved: OptimizeAchieved;
  toleranceMet: ToleranceMet;
  /** The single output row's largest fraction of total RTP. */
  maxRowRtpShare: number;
  warnings: string[];
}
