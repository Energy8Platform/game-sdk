// test/qp.test.ts
import { describe, expect, it } from 'vitest';
import { solveQP, projectSimplex } from '../src/qp.js';

describe('projectSimplex', () => {
  it('projects to the simplex when input sum exceeds T', () => {
    // y = [4, 3, 2, 1], T = 5
    // expected: tau s.t. max(0, y - tau) sums to 5; sort desc [4,3,2,1]
    //   j=0: cssv=4, thresh=(4-5)/1=-1, 4-(-1)=5>0, rho=0
    //   j=1: cssv=7, thresh=(7-5)/2=1, 3-1=2>0, rho=1
    //   j=2: cssv=9, thresh=(9-5)/3=1.333, 2-1.333=0.667>0, rho=2
    //   j=3: cssv=10, thresh=(10-5)/4=1.25, 1-1.25<0, stop
    // tau = (9-5)/3 = 4/3
    // result: max(0, [4,3,2,1] - 4/3) = [8/3, 5/3, 2/3, 0]
    const out = projectSimplex([4, 3, 2, 1], 5);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(5, 8);
    expect(out[0]).toBeCloseTo(8 / 3, 6);
    expect(out[3]).toBeCloseTo(0, 6);
  });

  it('caps each entry at ≥ 0', () => {
    const out = projectSimplex([-10, -5, 1, 2], 1);
    for (const v of out) expect(v).toBeGreaterThanOrEqual(-1e-12);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
  });

  it('handles uniform input', () => {
    // y = [1,1,1,1], T = 4 → x = [1,1,1,1]
    const out = projectSimplex([1, 1, 1, 1], 4);
    for (const v of out) expect(v).toBeCloseTo(1, 8);
  });
});

describe('solveQP', () => {
  it('solves trivial unconstrained-like case where prior is feasible', () => {
    // A = [[1,1,1]], b = [3], prior = [1,1,1], T = 3
    // The prior itself satisfies sum=3 and the equation Σx = 3.
    const x = solveQP([[1, 1, 1]], [3], {
      sumConstraint: 3,
      prior: [1, 1, 1],
      regularization: 1e-6,
    });
    expect(x.reduce((a, b) => a + b, 0)).toBeCloseTo(3, 6);
    for (const v of x) expect(v).toBeGreaterThanOrEqual(-1e-9);
    expect(x[0]).toBeCloseTo(1, 3);
    expect(x[1]).toBeCloseTo(1, 3);
    expect(x[2]).toBeCloseTo(1, 3);
  });

  it('respects non-negativity when LS solution would go negative', () => {
    // A = [[1, -1]], b = [-2], T = 2: unconstrained LS pushes x[0] toward 0
    // and x[1] toward 2.
    const x = solveQP([[1, -1]], [-2], {
      sumConstraint: 2,
      prior: [1, 1],
      regularization: 1e-4,
    });
    expect(x.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 6);
    for (const v of x) expect(v).toBeGreaterThanOrEqual(-1e-9);
    expect(x[0]).toBeLessThan(0.5);
    expect(x[1]).toBeGreaterThan(1.5);
  });

  it('matches solveNNLS to working tolerance on the underdetermined 2×4 case', () => {
    // Same test as in nnls.test.ts: A=[[1,1,0,0],[0,0,1,1]], b=[4,6], prior=[1,1,1,1], T=10
    // Tikhonov pulls toward x≈[2,2,3,3]. Sum constraint is enforced exactly here (4+6=10).
    const x = solveQP(
      [[1, 1, 0, 0], [0, 0, 1, 1]],
      [4, 6],
      {
        sumConstraint: 10,
        prior: [1, 1, 1, 1],
        regularization: 1e-6,
      },
    );
    expect(x.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 4);
    expect(x[0]).toBeCloseTo(2, 1);
    expect(x[1]).toBeCloseTo(2, 1);
    expect(x[2]).toBeCloseTo(3, 1);
    expect(x[3]).toBeCloseTo(3, 1);
  });

  it('converges for n=10000 in under 1 second', () => {
    // Random feasible problem
    const n = 10_000;
    const T = n * 100; // 1_000_000
    const A: number[][] = [
      Array.from({ length: n }, (_, i) => (i % 100)),
      Array.from({ length: n }, (_, i) => ((i * 7) % 200)),
      Array.from({ length: n }, () => 1),
    ];
    const b = [T * 50, T * 100, T * 0.3];

    const t0 = performance.now();
    const x = solveQP(A, b, {
      sumConstraint: T,
      regularization: 1e-6,
      maxIterations: 200,
    });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(x.reduce((a, b) => a + b, 0)).toBeCloseTo(T, 0); // exact via projection
    for (const v of x) expect(v).toBeGreaterThanOrEqual(-1e-6);
  });
});
