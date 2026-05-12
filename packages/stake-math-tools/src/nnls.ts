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
 * is applied *implicitly* — we never materialize the √ε · I block. Folding it into
 * the gradient and the normal equations keeps the storage at O(m · n) instead of
 * O(n²), which matters when n can reach 10⁵.
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

  // No augmentation: A stays m×n. Tikhonov enters only via the gradient
  // (in lawsonHansonNNLS) and the normal equations (in solveLS).
  // Shallow-copy A to a mutable number[][] for the inner routine.
  const Ah: number[][] = new Array(m);
  for (let i = 0; i < m; i++) Ah[i] = A[i].slice();
  const bh: number[] = b.slice();

  return lawsonHansonNNLS(Ah, bh, n, tol, maxIter, epsilon, prior);
}

/**
 * Lawson–Hanson active-set NNLS, matrix form. Returns x ≥ 0 minimizing
 * ||A x − b||² + ε ||x − prior||².
 *
 * Variables:
 *   P (passive set): indices where x_i > 0, x_i is "free"
 *   Z (active set):  indices where x_i = 0, x_i is "constrained"
 *   w = A_augᵀ(b_aug − A_aug x) — gradient of the augmented residual squared (negated).
 *       Split as w_j = (Aᵀ(b − A x))_j + ε · (prior_j − x_j).
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
  epsilon: number,
  prior: ReadonlyArray<number>,
): number[] {
  const m = A.length;
  const x = new Array(n).fill(0);
  const inP = new Array(n).fill(false);
  let iter = 0;

  while (iter++ < maxIter) {
    // residual r = b − A x  (against the un-augmented A only)
    const r = b.slice();
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += A[i][j] * x[j];
      r[i] -= s;
    }
    // w = Aᵀ r + ε · (prior − x)   ← implicit Tikhonov in the gradient
    const w = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += A[i][j] * r[i];
      if (epsilon > 0) s += epsilon * (prior[j] - x[j]);
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
      const sP = solveLS(A, b, pIdx, epsilon, prior);
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
 * Solve unconstrained LS for the passive subset: argmin ‖A_P x_P − b‖² + ε ‖x_P − prior_P‖²
 * where A_P is the columns of A indexed by `pIdx`. Uses normal equations
 *   (A_Pᵀ A_P + ε I) x = A_Pᵀ b + ε · prior_P
 * with Gaussian elimination — adequate for the small passive sets that arise in
 * Tikhonov-regularized NNLS (|P| ≤ m + a few extras at convergence).
 *
 * The Tikhonov term enters as +ε on the Gram diagonal and +ε·prior on the RHS,
 * which is exactly what augmenting A with √ε · I would produce — without the
 * O(n²) storage.
 */
function solveLS(
  A: number[][],
  b: number[],
  pIdx: ReadonlyArray<number>,
  epsilon = 0,
  prior?: ReadonlyArray<number>,
): number[] {
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

  // Implicit Tikhonov: add ε to the Gram diagonal and ε·prior to the RHS.
  if (epsilon > 0) {
    for (let col = 0; col < k; col++) {
      G[col][col] += epsilon;
      if (prior !== undefined) G[col][k] += epsilon * prior[pIdx[col]];
    }
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
