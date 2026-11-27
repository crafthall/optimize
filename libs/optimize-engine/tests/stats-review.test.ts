// Independent QA review of the `compare` statistics (review record
// 1. Coverage: the reported 95% CI must cover the true ratio about 95% of the time at T1-sized n (3 tasks × 4 runs per
//    arm), and a "measured saving" must not be claimed more often than 2.5% when the true ratio is exactly 0.85.
//    The plain percentile bootstrap covered 0.898 and claimed 5.0% (review §2) – these tests failed before the fix.
// 2. One run per arm in a task gives no variance estimate; a zero-width interval must never become "measured saving".
// 3. Quality bound: "no drop larger than X pp detected" must hold with at least 95% exact binomial coverage; the old
//    "observed drop + 300/n" covered only 0.865 at 12 vs 12 runs (review §4).
// 4. Student t quantiles against published two-sided 95% critical values (any t table, e.g. NIST/SEMATECH e-Handbook
//    §1.3.6.7.2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyzeRuns, binomialUpper, mulberry32, qualityBound, studentTQuantile, type ComparisonRecordV1 } from '../src';

/**
 * Limit of the simulation tests: 600 simulated comparisons × 1,000 resamples take a few seconds on an idle
 * machine, but one passed 60 s at a load of ~300. The simulation size stays (it sets the power of the coverage checks);
 * only the limit is wider – never a retry or a skip.
 */
const SIM_TIMEOUT_MS = 180_000;

type Runs = ComparisonRecordV1['runs'];
const metrics = (cost: number) => ({ inputTokens: 1, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0, outputTokens: 1, totalCostUsd: cost, durationApiMs: 1, model: 'claude-opus-5-5' });

/** Log-normal runs (CV 0.30, σ = √ln 1.09) for `tasks` tasks × `m` runs per arm, changed arm scaled by `ratio`. */
function simulateRuns(rand: () => number, tasks: number, m: number, ratio: number): Runs {
  const sigma = Math.sqrt(Math.log(1.09));
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const runs: Runs = [];
  let seq = 0;
  for (let k = 0; k < tasks; k++)
    for (let i = 0; i < m; i++) {
      const base = 0.1 * (k + 1);
      runs.push({ seq: seq++, fixture: `f${k}`, arm: 'baseline', oracleExitCode: 0, metrics: metrics(base * Math.exp(sigma * gauss())) });
      runs.push({ seq: seq++, fixture: `f${k}`, arm: 'changed', oracleExitCode: 0, metrics: metrics(base * ratio * Math.exp(sigma * gauss())) });
    }
  return runs;
}

describe('review: CI coverage at T1-sized n (simulation)', () => {
  const SIMS = 600;
  it('the reported 95% CI covers the true ratio at least 93% of the time at 3 tasks × 4 runs per arm', () => {
    const rand = mulberry32(20261126);
    let cover = 0;
    for (let s = 0; s < SIMS; s++) {
      const ci = analyzeRuns(simulateRuns(rand, 3, 4, 0.7), [], { seed: s + 1, resamples: 1000, status: 'complete' }).result.ci95!;
      if (ci[0] <= 0.7 && 0.7 <= ci[1]) cover++;
    }
    // binomial SE at 0.95 with 600 draws ≈ 0.009; 0.93 is about 2 SE below nominal; the old interval gave ≈ 0.90.
    expect(cover / SIMS).toBeGreaterThanOrEqual(0.93);
  }, SIM_TIMEOUT_MS);

  it('"measured saving" is claimed at most ~2.5% of the time when the true ratio is exactly 0.85', () => {
    const rand = mulberry32(85);
    let claims = 0;
    for (let s = 0; s < SIMS; s++) if (analyzeRuns(simulateRuns(rand, 3, 4, 0.85), [], { seed: s + 1, resamples: 1000, status: 'complete' }).verdict.code === 'measured-saving') claims++;
    // nominal 0.025, SE ≈ 0.0064 with 600 draws; the old interval claimed ≈ 0.050.
    expect(claims / SIMS).toBeLessThanOrEqual(0.04);
  }, SIM_TIMEOUT_MS);
});

describe('review: a task arm with one run', () => {
  it('one run per arm can never yield "measured saving" (no variance estimate)', () => {
    const runs: Runs = [
      { seq: 0, fixture: 'a', arm: 'baseline', oracleExitCode: 0, metrics: metrics(1) },
      { seq: 1, fixture: 'a', arm: 'changed', oracleExitCode: 0, metrics: metrics(0.5) },
      { seq: 2, fixture: 'b', arm: 'baseline', oracleExitCode: 0, metrics: metrics(2) },
      { seq: 3, fixture: 'b', arm: 'changed', oracleExitCode: 0, metrics: metrics(1.1) },
    ];
    const a = analyzeRuns(runs, [], { seed: 1, status: 'complete' });
    expect(a.verdict.code).toBe('not-enough-evidence');
    expect(a.result.ci95).toBeNull();
    expect(a.verdict.text).toMatch(/^Not enough evidence: at least 2 counted runs per arm in every task/);
  });

  it('the same holds when exclusions leave one run in one arm of one task (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 }), (seed) => {
        const runs = simulateRuns(mulberry32(seed), 3, 4, 0.3);
        // exclude 3 of the 4 changed runs of task f0 (seq 1, 3, 5 are f0 changed runs 0..2)
        const a = analyzeRuns(runs, [1, 3, 5].map((s) => ({ seq: s, reason: 'run-error' as const })), { seed, resamples: 200, status: 'complete' });
        expect(a.verdict.code).toBe('not-enough-evidence');
      }),
      { numRuns: 30 },
    );
  });
});

// Exact coverage of the quality bound by binomial enumeration (independent of the engine's beta function).
const logChoose = (n: number, k: number) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; };
const pmf = (n: number, k: number, p: number) => (p <= 0 ? (k === 0 ? 1 : 0) : p >= 1 ? (k === n ? 1 : 0) : Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p)));
function minCoverage(n: number): number {
  let worst = 1;
  for (let pa = 0.5; pa <= 1 + 1e-9; pa += 0.05)
    for (let pc = 0; pc <= pa + 1e-9; pc += 0.025) {
      const drop = 100 * (pa - pc);
      let cov = 0;
      for (let xa = 0; xa <= n; xa++)
        for (let xc = 0; xc <= n; xc++) {
          const w = pmf(n, xa, Math.min(1, pa)) * pmf(n, xc, pc);
          if (w > 1e-15 && qualityBound({ baseline: { passed: xa, total: n }, changed: { passed: xc, total: n } })!.maxDropPp >= drop - 1e-9) cov += w;
        }
      worst = Math.min(worst, cov);
    }
  return worst;
}

describe('review: quality bound', () => {
  it('exact coverage of "no drop larger than X pp" is at least 95% at 5, 12 and 30 runs per arm', () => {
    for (const n of [5, 12, 30]) expect(minCoverage(n)).toBeGreaterThanOrEqual(0.95 - 1e-9);
  }, SIM_TIMEOUT_MS);

  it('zero failures in the changed arm keep the rule of three (300/n); failures use the exact one-sided 95% binomial bound', () => {
    expect(qualityBound({ baseline: { passed: 12, total: 12 }, changed: { passed: 12, total: 12 } })!.maxDropPp).toBeCloseTo(25, 9);
    // Clopper–Pearson one-sided 95% upper bounds on the failure rate, qbeta(0.95, f + 1, n − f); reference values from an
    // independent bisection on the binomial CDF (review §4): f = 1 of 12 → 33.868%, 2 of 12 → 43.811%, 6 of 12 → 75.470%.
    expect(qualityBound({ baseline: { passed: 12, total: 12 }, changed: { passed: 11, total: 12 } })!.maxDropPp).toBeCloseTo(33.87, 1);
    expect(qualityBound({ baseline: { passed: 12, total: 12 }, changed: { passed: 10, total: 12 } })!.maxDropPp).toBeCloseTo(43.81, 1);
    expect(qualityBound({ baseline: { passed: 12, total: 12 }, changed: { passed: 6, total: 12 } })!.maxDropPp).toBeCloseTo(75.47, 1);
    expect(qualityBound({ baseline: { passed: 3, total: 3 }, changed: { passed: 0, total: 3 } })!.maxDropPp).toBe(100);
    // shrunk counterexample of the monotonicity property: 2 runs, 1 failure – exact bound 97.47 < rule of three cap 100
    expect(qualityBound({ baseline: { passed: 2, total: 2 }, changed: { passed: 1, total: 2 } })!.maxDropPp).toBe(100);
  });

  it('the bound is at least the observed failure rate and never falls when the changed arm fails more (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), (n, fa, f) => {
        const xa = Math.min(n, fa);
        const fc0 = Math.min(n, f);
        const q = qualityBound({ baseline: { passed: xa, total: n }, changed: { passed: n - fc0, total: n } })!;
        expect(q.maxDropPp).toBeGreaterThanOrEqual((100 * fc0) / n - 1e-9);
        expect(q.maxDropPp).toBeGreaterThanOrEqual(Math.max(0, q.observedDropPp) - 1e-9);
        expect(q.maxDropPp).toBeLessThanOrEqual(100);
        if (fc0 < n) {
          const worse = qualityBound({ baseline: { passed: xa, total: n }, changed: { passed: n - fc0 - 1, total: n } })!;
          expect(worse.maxDropPp).toBeGreaterThanOrEqual(q.maxDropPp - 1e-9);
        }
      }),
    );
  });

  it('binomialUpper matches the closed form 1 − α^(1/n) at zero failures', () => {
    for (const n of [1, 5, 12, 30]) expect(binomialUpper(0, n, 0.95)).toBeCloseTo(1 - 0.05 ** (1 / n), 8);
  });
});

describe('review: Student t quantiles', () => {
  it('match published two-sided 95% critical values (t table)', () => {
    const table: [number, number][] = [[1, 12.706], [2, 4.303], [3, 3.182], [5, 2.571], [10, 2.228], [18, 2.101], [30, 2.042], [120, 1.98]];
    for (const [df, t] of table) expect(studentTQuantile(0.975, df)).toBeCloseTo(t, 2);
    expect(studentTQuantile(0.975, 1e6)).toBeCloseTo(1.96, 3);
  });
});
