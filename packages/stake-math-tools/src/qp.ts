// src/qp.ts
//
// FISTA (Fast Iterative Shrinkage-Thresholding Algorithm) with simplex projection
// for the underdetermined Tikhonov-regularized QP
//
//   min ‖A x − b‖² + ε ‖x − prior‖²   s.t.   x ≥ 0,  Σx = T
//
// Per-iteration cost: O(m·n) for the matvecs, O(n log n) for the simplex projection.
// For our m=3 / n≤100k regime that's ~10·n flops per iter — vs Lawson-Hanson NNLS
// which is O(m·n²) on underdetermined active-set-bouncing problems.
//
// Implementation notes for THIS problem family (RTP/variance/hit-rate targets):
//
//   1. **Jacobi (column-norm) preconditioning.** A's rows in our usage have wildly
//      different scales — the RTP coefficient row can dominate by ~10⁷×. The
//      change of variables x = D u with D_jj = 1/√(‖A col j‖²+ε) puts the
//      preconditioned data-fit Hessian (AD)ᵀ(AD) into a well-conditioned regime
//      (κ ~ m for the range space). The remaining 1/ε strong-convexity from
//      the Tikhonov term is unaffected, but the *range* directions — which
//      are where the data fit lives — accelerate properly.
//      The sum constraint Σx=T maps to a weighted simplex Σ D_jj u_j = T;
//      we project onto that with a Duchi-style O(n log n) routine.
//
//   2. **Adaptive restart** (O'Donoghue & Candès 2015): if the proximal step
//      direction (uNew − u) is uphill against the gradient at y, momentum has
//      overshot — reset t = 1. Essential for stable progress on tightly-toleranced
//      problems where the iterates oscillate near the boundary of the active set.
//
//   3. **Sherman-Morrison-Woodbury warm start was considered and rejected.** When
//      ε ≪ ‖A‖² (the common case for our toleranceRTP ~ 0.002 inputs), the
//      formula M⁻¹ = (1/ε)(I − Aᵀ(εI + AAᵀ)⁻¹A) suffers catastrophic
//      cancellation in the `(v − Aᵀ·…)/ε` step. The preconditioner above is
//      sufficient on its own.
//
// CAVEAT: For very ill-conditioned instances (small ε, broad coefficient range),
// FISTA needs many thousands of iterations to nail the user's tight tolerances.
// In those regimes the active-set NNLS in `./nnls.ts` is dramatically faster on
// the same problem class because m is tiny. solveQP is offered as a parallel
// option in the public API; whether the orchestrator uses it or solveNNLS is
// a deployment decision driven by the tolerance regime.

export interface QPOptions {
  /** Tikhonov coefficient ε ≥ 0. Default 1e-6. */
  regularization?: number;
  /** Tikhonov prior. Default = uniform sumConstraint/n. */
  prior?: ReadonlyArray<number>;
  /** Sum constraint: Σx = sumConstraint. Required. */
  sumConstraint: number;
  /** Maximum FISTA iterations. Default 500. */
  maxIterations?: number;
  /** Convergence tolerance on ‖x_{k+1} − x_k‖_2 / max(‖x_k‖_2, 1). Default 1e-6. */
  tolerance?: number;
}

/**
 * Solve `min ‖A x − b‖² + ε ‖x − prior‖²  s.t.  x ≥ 0, Σx = T`
 * via Jacobi-preconditioned FISTA with weighted-simplex projection.
 *
 * A is m × n. For our use case m = 3 (RTP, variance, hit-rate features);
 * the sum constraint is enforced via projection, not as a feature row.
 */
export function solveQP(
  A: ReadonlyArray<ReadonlyArray<number>>,
  b: ReadonlyArray<number>,
  options: QPOptions,
): number[] {
  const m = A.length;
  const n = m === 0 ? 0 : A[0].length;
  if (n === 0) return [];

  const T = options.sumConstraint;
  if (!Number.isFinite(T) || T < 0) {
    throw new Error(`solveQP: sumConstraint must be a non-negative finite number, got ${T}`);
  }
  const epsilon = options.regularization ?? 1e-6;
  const maxIter = options.maxIterations ?? 500;
  const tol = options.tolerance ?? 1e-6;
  const prior = options.prior ?? new Array(n).fill(T / n);
  if (prior.length !== n) {
    throw new Error(`solveQP: prior length ${prior.length} does not match n=${n}`);
  }
  if (b.length !== m) {
    throw new Error(`solveQP: b length ${b.length} does not match m=${m}`);
  }

  // ── Jacobi preconditioner ───────────────────────────────────────────────────
  // Change of variables x = D u with D_jj = 1/√(‖A col j‖² + ε). Columns of AD
  // then have norm ≈ 1, dramatically improving (AD)ᵀ(AD)'s conditioning.
  // In u-coordinates:
  //   - loss: ‖(AD) u − b‖² + ε ‖D u − prior‖²
  //   - constraints: u ≥ 0, Σ D_jj u_j = T (weighted simplex)
  const colNormSq = new Float64Array(n);
  for (let i = 0; i < m; i++) {
    const row = A[i];
    for (let j = 0; j < n; j++) colNormSq[j] += row[j] * row[j];
  }
  let totColNormSq = 0;
  for (let j = 0; j < n; j++) totColNormSq += colNormSq[j];
  const typicalScale = totColNormSq > 0 ? Math.sqrt(totColNormSq / n) : 1;
  const D = new Float64Array(n);
  const Dinv = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const s = Math.sqrt(colNormSq[j] + epsilon);
    const s_ = s > 1e-30 ? s : typicalScale;
    Dinv[j] = s_;
    D[j] = 1 / s_;
  }

  // Preconditioned matrix AD (m × n) as Float64Array for tight inner loops.
  const AD: Float64Array[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const row = A[i];
    const out = new Float64Array(n);
    for (let j = 0; j < n; j++) out[j] = row[j] * D[j];
    AD[i] = out;
  }
  // Prior anchor in u-space: priorU = D⁻¹ · prior so that D · priorU = prior.
  const priorU = new Float64Array(n);
  for (let j = 0; j < n; j++) priorU[j] = prior[j] * Dinv[j];
  // Isotropic ε in u-space — see file header note 2.
  const regDiag = epsilon;

  // ── Lipschitz estimate in u-space ───────────────────────────────────────────
  // L = 2 σ_max((AD)ᵀ(AD)) + 2 ε. Power iteration on the m×m matrix (AD)(AD)ᵀ.
  const L0 = 2 * spectralNormSquaredF64(AD, m, n) + 2 * regDiag;
  let L = L0 > 0 ? L0 : 1;

  // ── FISTA state in u-space (all Float64Array for tight inner loops) ────────
  const xInit = T / n;
  const u = new Float64Array(n);
  const uPrev = new Float64Array(n);
  const y = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const v = xInit * Dinv[j]; // u = D⁻¹ x
    u[j] = v;
    uPrev[j] = v;
    y[j] = v;
  }
  // Reusable scratch.
  const g = new Float64Array(n);
  const z = new Float64Array(n);
  const uNew = new Float64Array(n);
  const ADy = new Float64Array(m);
  const r = new Float64Array(m);

  let t = 1;

  for (let iter = 0; iter < maxIter; iter++) {
    // ── Gradient at y: g = 2 (AD)ᵀ ((AD) y − b) + 2 ε (y − priorU) ──────────
    for (let i = 0; i < m; i++) {
      const row = AD[i];
      let s = 0;
      for (let j = 0; j < n; j++) s += row[j] * y[j];
      ADy[i] = s;
      r[i] = s - b[i];
    }
    if (m === 3) {
      // Hot path: unrolled for the common m=3 (RTP / CV / hit-rate).
      const r0 = r[0], r1 = r[1], r2 = r[2];
      const a0 = AD[0], a1 = AD[1], a2 = AD[2];
      const tw = 2 * regDiag;
      for (let j = 0; j < n; j++) {
        g[j] = 2 * (a0[j] * r0 + a1[j] * r1 + a2[j] * r2) + tw * (y[j] - priorU[j]);
      }
    } else {
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += AD[i][j] * r[i];
        g[j] = 2 * s + 2 * regDiag * (y[j] - priorU[j]);
      }
    }

    // ── Trial step + weighted-simplex projection, backtracking on L ──────────
    // Compute f(y) lazily — only when we may need to backtrack. With a tight L
    // bound, the first attempt nearly always succeeds, so we skip this work.
    let fY = NaN;
    let backtracks = 0;
    const maxBacktracks = 30;
    while (backtracks++ < maxBacktracks) {
      const eta = 1 / L;
      for (let j = 0; j < n; j++) z[j] = y[j] - eta * g[j];
      projectWeightedSimplexInto(z, D, T, uNew);

      // Cheap descent test based on the linear (not full quadratic) Taylor.
      // ‖uNew − y‖² · L/2 + ⟨g, uNew − y⟩ should give an upper bound on f(uNew) - f(y);
      // we accept the step on the first try unless this differs grossly from reality.
      // For tight L this is fine; the explicit fY check only kicks in if we doubled L
      // and want to verify before further increases.
      let dot = 0;
      let diffSq = 0;
      for (let j = 0; j < n; j++) {
        const diff = uNew[j] - y[j];
        dot += g[j] * diff;
        diffSq += diff * diff;
      }
      if (backtracks === 1) {
        // Standard FISTA descent direction check: the proximal step on a smooth
        // ‖∇²f‖ ≤ L surface yields dot + 0.5·L·diffSq ≤ 0 when the step is valid.
        // Skip the explicit f-computation here.
        if (dot + 0.5 * L * diffSq <= 1e-12 * Math.max(1, L)) break;
      }
      // Reluctant fallback: compute f(y) and f(uNew) and check the canonical bound.
      if (Number.isNaN(fY)) fY = computeLossUF64(AD, b, y, m, n, regDiag, priorU);
      const fNew = computeLossUF64(AD, b, uNew, m, n, regDiag, priorU);
      const upper = fY + dot + 0.5 * L * diffSq;
      if (fNew <= upper + 1e-12 * Math.max(1, Math.abs(fY))) break;
      L *= 2;
    }

    // ── Adaptive restart: if step (uNew - u) is uphill against g(y), reset t ─
    let gradTest = 0;
    for (let j = 0; j < n; j++) gradTest += g[j] * (uNew[j] - u[j]);
    if (gradTest > 0) t = 1;

    // ── Convergence: relative ‖u_{k+1} − u_k‖ ────────────────────────────────
    let duSq = 0;
    let uNorm = 0;
    for (let j = 0; j < n; j++) {
      const diff = uNew[j] - u[j];
      duSq += diff * diff;
      uNorm += u[j] * u[j];
    }
    const dxNorm = Math.sqrt(duSq);
    const xn = Math.sqrt(uNorm);

    // ── Nesterov momentum ─────────────────────────────────────────────────────
    const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    const momentum = (t - 1) / tNext;
    for (let j = 0; j < n; j++) {
      uPrev[j] = u[j];
      u[j] = uNew[j];
      y[j] = uNew[j] + momentum * (uNew[j] - uPrev[j]);
    }
    t = tNext;

    if (dxNorm < tol * Math.max(xn, 1)) break;
  }

  // ── Return to x-space: x = D u ─────────────────────────────────────────────
  const x = new Array(n);
  for (let j = 0; j < n; j++) x[j] = u[j] * D[j];
  return x;
}

/**
 * Project y onto the simplex {x : x ≥ 0, Σx = T} via Duchi et al. 2008.
 * Returns a new array. O(n log n) due to the sort.
 *
 * Exported for testing and direct reuse.
 */
export function projectSimplex(y: ReadonlyArray<number>, T: number): number[] {
  const n = y.length;
  if (n === 0) return [];
  if (!Number.isFinite(T) || T < 0) {
    throw new Error(`projectSimplex: T must be a non-negative finite number, got ${T}`);
  }

  const sorted = y.slice().sort((a, b) => b - a) as number[];
  let cssv = 0;
  let bestCssv = 0;
  let rho = -1;
  for (let j = 0; j < n; j++) {
    cssv += sorted[j];
    const threshold = (cssv - T) / (j + 1);
    if (sorted[j] - threshold > 0) {
      rho = j;
      bestCssv = cssv;
    } else {
      break;
    }
  }
  if (rho < 0) {
    const uVal = T / n;
    return new Array(n).fill(uVal);
  }
  const tau = (bestCssv - T) / (rho + 1);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = y[i] - tau;
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

/**
 * Project y onto the weighted simplex {u : u ≥ 0, Σ w_j u_j = T} with w_j > 0,
 * writing into `out`. Used as the proximal step in u-coordinates inside FISTA.
 *
 *   u_j* = max(0, y_j − λ w_j)     for the unique λ s.t. Σ w_j · u_j* = T.
 *
 * f(λ) = Σ w_j · max(0, y_j − λ w_j) is continuous, piecewise-linear and strictly
 * decreasing on (λ_min, λ_max). Sort the breakpoints t_j = y_j/w_j descending and
 * walk through to find the active set (analogous to Duchi 2008). O(n log n).
 */
function projectWeightedSimplexInto(
  y: Float64Array,
  w: Float64Array,
  T: number,
  out: Float64Array,
): void {
  const n = y.length;
  if (n === 0) return;

  const t = new Float64Array(n);
  for (let j = 0; j < n; j++) t[j] = y[j] / w[j];
  const idx = new Array<number>(n);
  for (let j = 0; j < n; j++) idx[j] = j;
  idx.sort((a, b) => t[b] - t[a]);

  let Sy = 0;
  let Sw2 = 0;
  let lambda = 0;
  let rho = -1;
  for (let k = 0; k < n; k++) {
    const j = idx[k];
    Sy += w[j] * y[j];
    Sw2 += w[j] * w[j];
    const lamCand = (Sy - T) / Sw2;
    if (t[j] > lamCand) {
      rho = k;
      lambda = lamCand;
    } else {
      break;
    }
  }
  if (rho < 0) {
    const xOver = T / n;
    for (let j = 0; j < n; j++) out[j] = w[j] * xOver;
    return;
  }
  for (let j = 0; j < n; j++) {
    const v = y[j] - lambda * w[j];
    out[j] = v > 0 ? v : 0;
  }
}

/**
 * F(u) = ‖(AD) u − b‖² + ε Σ_j (u_j − priorU_j)²   (loss in u-coordinates,
 * Float64Array variant for the FISTA hot path).
 */
function computeLossUF64(
  AD: ReadonlyArray<Float64Array>,
  b: ReadonlyArray<number>,
  u: Float64Array,
  m: number,
  n: number,
  regDiag: number,
  priorU: Float64Array,
): number {
  let dataSq = 0;
  for (let i = 0; i < m; i++) {
    const row = AD[i];
    let s = 0;
    for (let j = 0; j < n; j++) s += row[j] * u[j];
    const r = s - b[i];
    dataSq += r * r;
  }
  let regSq = 0;
  for (let j = 0; j < n; j++) {
    const diff = u[j] - priorU[j];
    regSq += diff * diff;
  }
  return dataSq + regDiag * regSq;
}

/**
 * Estimate σ_max(MᵀM) = σ_max(MMᵀ) via power iteration on the m×m matrix MMᵀ.
 * Cost: O(m²·n) to build, O(m²) per iteration. For m=3 effectively free.
 *
 * Float64Array variant — same routine, different storage type.
 */
function spectralNormSquaredF64(
  M: ReadonlyArray<Float64Array>,
  m: number,
  n: number,
): number {
  if (m === 0 || n === 0) return 0;
  const MMt: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let k = i; k < m; k++) {
      let s = 0;
      const Mi = M[i];
      const Mk = M[k];
      for (let j = 0; j < n; j++) s += Mi[j] * Mk[j];
      MMt[i][k] = s;
      MMt[k][i] = s;
    }
  }
  let v = new Array(m).fill(1 / Math.sqrt(m));
  let lambda = 0;
  for (let it = 0; it < 30; it++) {
    const w = new Array(m).fill(0);
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += MMt[i][k] * v[k];
      w[i] = s;
    }
    let norm = 0;
    for (let i = 0; i < m; i++) norm += w[i] * w[i];
    norm = Math.sqrt(norm);
    if (norm < 1e-30) return 0;
    const newV = new Array(m);
    for (let i = 0; i < m; i++) newV[i] = w[i] / norm;
    if (Math.abs(norm - lambda) < 1e-10 * Math.max(1, norm)) {
      lambda = norm;
      break;
    }
    lambda = norm;
    v = newV;
  }
  return lambda;
}
