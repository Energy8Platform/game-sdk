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

  /** Cost of a single bet in cents. Used to convert payouts to "bet multiplier" units
   *  for the Stake-style report. Default 100 (1.0 bet = 100 cents). */
  betCostCents?: number;

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

  /** Maximum integer weight allowed for any single output row, as a multiple of the
   *  uniform prior weight (totalWeightOut / nRowsOut). E.g., 10 means no row can have
   *  weight greater than 10 × (totalWeightOut / nRowsOut). This prevents Stake's ETL
   *  ("Within Liability Limits") check from failing due to over-concentrated weight.
   *  Default 10. Set to Infinity to disable. */
  maxWeightPerRow?: number;
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
  /** True if no output row's weight exceeds maxWeightPerRow × (totalWeightOut / nRowsOut). */
  weightCap: boolean;
}

export interface TopKShare {
  /** Cumulative share of total RTP coming from the top-K rows (ordered by w·payout descending). */
  k: number;
  share: number;
}

export interface StakeReport {
  /** Maximum payout in the output, as a bet multiplier (payoutCents / betCostCents). */
  payoutMultMax: number;

  /** Standard deviation of payouts in bet-cost units (= stddev_payout_cents / betCostCents).
   *  Equivalent to cv × rtp × (100 / betCostCents). For bet=100 cents, equals cv × rtp × 1. */
  baseStd: number;

  /** Probability that a sampled spin pays ≥ 5000 × betCost. */
  prob5K: number;

  /** Probability that a sampled spin pays ≥ 10000 × betCost. */
  prob10K: number;

  /** Top-K cumulative RTP shares, sorted by per-row (w × payout) descending.
   *  Standard K values reported: 1, 5, 10, 100. */
  topKShare: TopKShare[];

  /** Bet cost in cents used for the multiplier conversions (echoed from params). */
  betCostCents: number;
}

export interface OptimizeResult {
  rows: LookupRow[];
  achieved: OptimizeAchieved;
  toleranceMet: ToleranceMet;
  /** The single output row's largest fraction of total RTP. */
  maxRowRtpShare: number;
  /** Maximum integer weight observed in output, as a multiple of uniform prior. */
  maxWeightRatio: number;
  warnings: string[];
  stakeReport: StakeReport;
}
