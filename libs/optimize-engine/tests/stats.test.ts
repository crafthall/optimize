// Statistics of `compare` (R0-07). Unit: the worked numbers of validation §3.4. Differential: an independent
// reference (normal CDF by Simpson integration, quantile by bisection, sample size by search; ratio by per-task
// geometric means; bootstrap with a different RNG). Property: identical arms, scale invariance, shift equivariance,
// MDE monotone in n, determinism.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bootstrapRatioCi,
  ciContainsOne,
  geometricCostRatio,
  logSigma,
  minimumDetectableEffect,
  normalQuantile,
  paybackMonths,
  qualityBound,
  sampleSizePerArm,
  verdictCode,
  zSum,
  type TaskCosts,
} from '../src';

// ---- Independent reference (different formula path) -------------------------------------------------------------
const pdf = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
/** Φ(x) by composite Simpson integration of the pdf from 0 to x. */
const refCdf = (x: number): number => {
  const n = 2000;
  const h = x / n;
  let s = pdf(0) + pdf(x);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * pdf(i * h);
  return 0.5 + (s * h) / 3;
};
/** Φ⁻¹(p) by bisection on refCdf. */
const refQuantile = (p: number): number => {
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (refCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};
const refZ = refQuantile(0.975) + refQuantile(0.8);
/** MDE from the variance of the log-ratio estimator: SE = σ·√(2/n), detectable log effect = z·SE. */
const refMde = (cv: number, n: number): number => {
  const variance = Math.log(1 + cv * cv);
  const se = Math.sqrt((2 * variance) / n);
  return 1 - 1 / Math.exp(refZ * se);
};
/** Smallest n whose reference MDE is at most the saving, by linear search. */
const refSampleSize = (cv: number, saving: number): number => {
  let n = 1;
  while (refMde(cv, n) > saving + 1e-12) n++;
  return n;
};
/** Ratio as the geometric mean over tasks of (geometric mean changed ÷ geometric mean baseline), via products. */
const refRatio = (tasks: TaskCosts[]): number => {
  const gm = (xs: readonly number[]) => xs.reduce((p, x) => p * x ** (1 / xs.length), 1);
  return tasks.reduce((p, t) => p * (gm(t.changed) / gm(t.baseline)) ** (1 / tasks.length), 1);
};
/** Bootstrap with a different RNG (xorshift32) and a sort-based percentile: same estimand, independent noise. */
const refBootstrap = (tasks: TaskCosts[], resamples: number, seed: number): [number, number] => {
  let s = seed | 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const ratios: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const re = tasks.map((t) => ({
      task: t.task,
      baseline: t.baseline.map(() => t.baseline[Math.floor(rnd() * t.baseline.length)]!),
      changed: t.changed.map(() => t.changed[Math.floor(rnd() * t.changed.length)]!),
    }));
    ratios.push(refRatio(re));
  }
  ratios.sort((a, b) => a - b);
  return [ratios[Math.round(0.025 * (resamples - 1))]!, ratios[Math.round(0.975 * (resamples - 1))]!];
};

describe('validation §3.4 worked numbers (unit)', () => {
  it('z-sum is 1.960 + 0.842', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(zSum()).toBeCloseTo(2.80158, 4);
  });

  it('sample size per arm: the full table', () => {
    const table: [number, number, number][] = [
      [0.15, 0.1, 32], [0.15, 0.2, 8], [0.15, 0.3, 3], [0.15, 0.5, 1],
      [0.3, 0.1, 122], [0.3, 0.2, 28], [0.3, 0.3, 11], [0.3, 0.5, 3],
      [0.6, 0.1, 435], [0.6, 0.2, 97], [0.6, 0.3, 38], [0.6, 0.5, 11],
    ];
    for (const [cv, s, n] of table) expect(sampleSizePerArm(cv, s), `CV ${cv}, s ${s}`).toBe(n);
  });

  it('MDE at n = 12 and n = 30 per arm', () => {
    const cases: [number, number, number][] = [
      [0.15, 12, 0.157], [0.3, 12, 0.285], [0.6, 12, 0.47],
      [0.15, 30, 0.102], [0.3, 30, 0.191], [0.6, 30, 0.33],
    ];
    for (const [cv, n, mde] of cases) expect(Math.abs(minimumDetectableEffect(cv, n) - mde), `CV ${cv}, n ${n}`).toBeLessThan(0.0005);
  });

  it('payback: 244 runs × USD 0.39 at a 10% saving of USD 200/month ≈ 4.8 months', () => {
    expect(paybackMonths(244 * 0.39, 0.1, 200)).toBeCloseTo(4.76, 2);
    expect(paybackMonths(56 * 0.39, 0.2, 200)).toBeCloseTo(0.55, 2);
    expect(paybackMonths(10, 0.2, null)).toBeNull();
  });

  it('rule of three: zero failures in 10 / 20 / 30 runs → 30 / 15 / 10 pp', () => {
    for (const [n, pp] of [[10, 30], [20, 15], [30, 10]] as const)
      expect(qualityBound({ baseline: { passed: n, total: n }, changed: { passed: n, total: n } })!.maxDropPp).toBeCloseTo(pp, 9);
  });

  it('verdicts follow validation §3.3 M3', () => {
    expect(verdictCode(0.6, [0.5, 0.8])).toBe('measured-saving');
    expect(verdictCode(0.8, [0.7, 0.95])).toBe('likely-saving');
    expect(verdictCode(0.95, [0.92, 0.98])).toBe('not-enough-evidence');
    expect(verdictCode(0.7, [0.5, 1.0])).toBe('not-enough-evidence');
    expect(verdictCode(1.3, [1.1, 1.5])).toBe('not-enough-evidence');
    expect(verdictCode(null, null)).toBe('not-enough-evidence');
  });

  it('rejects invalid inputs', () => {
    expect(() => logSigma(0)).toThrow(RangeError);
    expect(() => sampleSizePerArm(0.3, 0)).toThrow(RangeError);
    expect(() => minimumDetectableEffect(0.3, 0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe('differential: engine vs independent reference', () => {
  it('z quantiles agree within 1e-6', () => {
    for (const p of [0.01, 0.05, 0.5, 0.8, 0.9, 0.95, 0.975, 0.99]) expect(Math.abs(normalQuantile(p) - refQuantile(p))).toBeLessThan(1e-6);
  });

  it('MDE agrees within 0.1 pp and sample size exactly on a grid of CV and n', () => {
    for (const cv of [0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 1]) {
      for (const n of [1, 2, 4, 8, 12, 20, 30, 60, 122]) expect(Math.abs(minimumDetectableEffect(cv, n) - refMde(cv, n)) * 100).toBeLessThan(0.1);
      for (const s of [0.1, 0.15, 0.2, 0.3, 0.5]) expect(sampleSizePerArm(cv, s)).toBe(refSampleSize(cv, s));
    }
  });

  const datasets = fc.array(
    fc.record({
      task: fc.constant('t'),
      baseline: fc.array(fc.double({ min: 0.01, max: 5, noNaN: true }), { minLength: 1, maxLength: 6 }),
      changed: fc.array(fc.double({ min: 0.01, max: 5, noNaN: true }), { minLength: 1, maxLength: 6 }),
    }),
    { minLength: 1, maxLength: 4 },
  );

  it('ratio agrees within 1e-6 (relative) on 1,000 generated datasets', () => {
    fc.assert(
      fc.property(datasets, (tasks) => {
        const a = geometricCostRatio(tasks)!;
        expect(Math.abs(a / refRatio(tasks) - 1)).toBeLessThan(1e-6);
      }),
      { numRuns: 1000, seed: 1031 },
    );
  });

  it('CI bounds agree within Monte Carlo tolerance (0.05 on the log scale, 4,000 resamples each) on 40 datasets', () => {
    fc.assert(
      fc.property(datasets, fc.integer({ min: 1, max: 2 ** 31 - 1 }), (tasks, seed) => {
        const [lo, hi] = bootstrapRatioCi(tasks, { seed, resamples: 4000 })!;
        const [rlo, rhi] = refBootstrap(tasks, 4000, seed ^ 0x5bd1e995);
        const spread = Math.log(rhi) - Math.log(rlo);
        const tol = 0.05 + 0.1 * spread;
        expect(Math.abs(Math.log(lo) - Math.log(rlo))).toBeLessThan(tol);
        expect(Math.abs(Math.log(hi) - Math.log(rhi))).toBeLessThan(tol);
      }),
      { numRuns: 40, seed: 2031 },
    );
  });
});

describe('properties', () => {
  const costs = fc.array(fc.double({ min: 0.01, max: 5, noNaN: true }), { minLength: 1, maxLength: 8 });
  const identical = fc.array(costs.map((xs) => ({ task: 't', baseline: xs, changed: [...xs] })), { minLength: 1, maxLength: 4 });

  it('identical arms: ratio 1, CI contains 1.0, verdict not-enough-evidence', () => {
    fc.assert(
      fc.property(identical, fc.integer(), (tasks, seed) => {
        const ratio = geometricCostRatio(tasks)!;
        const ci = bootstrapRatioCi(tasks, { seed, resamples: 2000 })!;
        expect(ratio).toBeCloseTo(1, 9);
        expect(ciContainsOne(ci)).toBe(true);
        expect(verdictCode(ratio, ci)).toBe('not-enough-evidence');
      }),
      { numRuns: 200 },
    );
  });

  const tasksArb = fc.array(fc.record({ task: fc.constant('t'), baseline: costs, changed: costs }), { minLength: 1, maxLength: 4 });

  it('scale invariance: multiplying every cost by k leaves ratio and CI unchanged', () => {
    fc.assert(
      fc.property(tasksArb, fc.double({ min: 0.01, max: 100, noNaN: true }), fc.integer(), (tasks, k, seed) => {
        const scaled = tasks.map((t) => ({ ...t, baseline: t.baseline.map((x) => x * k), changed: t.changed.map((x) => x * k) }));
        const [a, b] = [bootstrapRatioCi(tasks, { seed, resamples: 500 })!, bootstrapRatioCi(scaled, { seed, resamples: 500 })!];
        expect(geometricCostRatio(scaled)! / geometricCostRatio(tasks)!).toBeCloseTo(1, 9);
        expect(b[0] / a[0]).toBeCloseTo(1, 9);
        expect(b[1] / a[1]).toBeCloseTo(1, 9);
      }),
      { numRuns: 200 },
    );
  });

  it('shift equivariance: multiplying the changed arm by k multiplies ratio and both CI bounds by k', () => {
    fc.assert(
      fc.property(tasksArb, fc.double({ min: 0.1, max: 10, noNaN: true }), fc.integer(), (tasks, k, seed) => {
        const shifted = tasks.map((t) => ({ ...t, changed: t.changed.map((x) => x * k) }));
        const [a, b] = [bootstrapRatioCi(tasks, { seed, resamples: 500 })!, bootstrapRatioCi(shifted, { seed, resamples: 500 })!];
        expect(geometricCostRatio(shifted)! / geometricCostRatio(tasks)! / k).toBeCloseTo(1, 9);
        expect(b[0] / a[0] / k).toBeCloseTo(1, 9);
        expect(b[1] / a[1] / k).toBeCloseTo(1, 9);
      }),
      { numRuns: 200 },
    );
  });

  it('planned MDE never grows with more runs, and the sample size never shrinks with a higher CV or a smaller saving', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 2, noNaN: true }), fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 500 }), (cv, n1, n2) => {
        const [lo, hi] = n1 <= n2 ? [n1, n2] : [n2, n1];
        expect(minimumDetectableEffect(cv, hi)).toBeLessThanOrEqual(minimumDetectableEffect(cv, lo));
        expect(sampleSizePerArm(cv * 1.1, 0.2)).toBeGreaterThanOrEqual(sampleSizePerArm(cv, 0.2));
        expect(sampleSizePerArm(cv, 0.1)).toBeGreaterThanOrEqual(sampleSizePerArm(cv, 0.2));
      }),
    );
  });

  it('the bootstrap is deterministic for a seed and its bounds are ordered', () => {
    fc.assert(
      fc.property(tasksArb, fc.integer(), (tasks, seed) => {
        const a = bootstrapRatioCi(tasks, { seed, resamples: 300 })!;
        expect(bootstrapRatioCi(tasks, { seed, resamples: 300 })).toEqual(a);
        expect(a[0]).toBeLessThanOrEqual(a[1]);
      }),
      { numRuns: 100 },
    );
  });
});
