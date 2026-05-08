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
    // Every passive subset that includes x[0] or x[1] yields infeasible (negative)
    // unconstrained LS coords, so NNLS pins them to 0. The unique optimum is the
    // single-column passive subset {2}: x = [0, 0, 23/15] ≈ [0, 0, 1.5333] with
    // residual norm ≈ 2.6833.
    const x = solveNNLS([[1, 2, 3], [4, 5, 6]], [7, 8]);
    expect(x.every((v) => v >= 0)).toBe(true);
    expect(x[0]).toBeCloseTo(0, 8);
    expect(x[1]).toBeCloseTo(0, 8);
    expect(x[2]).toBeCloseTo(23 / 15, 6);
    // Residual norm matches the NNLS optimum (not the unconstrained LS optimum).
    const r0 = x[0] + 2 * x[1] + 3 * x[2] - 7;
    const r1 = 4 * x[0] + 5 * x[1] + 6 * x[2] - 8;
    expect(Math.sqrt(r0 * r0 + r1 * r1)).toBeCloseTo(2.6832815729997477, 6);
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
