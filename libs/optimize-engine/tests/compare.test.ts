// `compare` engine parts (R0-06…R0-08): the `claude -p` JSON reader on two result shapes, the plan block and
// its payback refusal, the interleaved schedule, the analysis into result and verdict, and the report text rules
// (verdict first, measurement cost shown, never "quality unchanged").
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analyzeRuns,
  isModelFallback,
  capVerdictForStop,
  modelPinKey,
  modelPinKeyFor,
  type StopReason,
  plannedModelMatcher,
  modelByArmText,
  type Arm,
  type ModelByArm,
  costLabels,
  formatPlan,
  formatReport,
  measuredSavingMde,
  measuredSavingMdeT,
  minimumDetectableEffectT,
  planDegreesOfFreedom,
  studentTQuantile,
  measurementCost,
  minimumDetectableEffect,
  parseClaudeJson,
  planComparison,
  ratioCi,
  recordVerdictText,
  runSchedule,
  validateRecord,
  type ComparisonRecordV1,
} from '../src';
import { validComparison as comparisonSample } from './samples';

/** Result shape without the cache-creation split (older Claude Code 1.x `-p` JSON). */
export const RESULT_V1 = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 41250,
  duration_api_ms: 38900,
  num_turns: 7,
  result: 'SECRET ANSWER TEXT that must never be read',
  session_id: '0b6f1d2e-0000-4000-8000-000000000001',
  total_cost_usd: 0.3871,
  usage: { input_tokens: 5120, cache_creation_input_tokens: 30210, cache_read_input_tokens: 301442, output_tokens: 8011 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 5120, outputTokens: 8011, costUSD: 0.3811 }, 'claude-haiku-4-5': { inputTokens: 900, outputTokens: 40, costUSD: 0.006 } },
});

/** Result shape with the 5m/1h cache-creation split (Claude Code 2.x `-p` JSON). */
export const RESULT_V2 = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_api_ms: 20100,
  total_cost_usd: 0.1925,
  usage: {
    input_tokens: 3000,
    cache_creation_input_tokens: 21000,
    cache_read_input_tokens: 150000,
    output_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 20000, ephemeral_1h_input_tokens: 1000 },
  },
  modelUsage: { 'claude-sonnet-4-6': { inputTokens: 3000, outputTokens: 4000, costUSD: 0.1925 } },
});

describe('parseClaudeJson', () => {
  it('reads the 1.x shape (no cache split) and picks the costliest model', () => {
    const r = parseClaudeJson(RESULT_V1)!;
    expect(r.metrics).toEqual({ inputTokens: 5120, cacheCreation5mTokens: 30210, cacheCreation1hTokens: 0, cacheReadTokens: 301442, outputTokens: 8011, totalCostUsd: 0.3871, durationApiMs: 38900, model: 'claude-opus-5-5', modelUsageTokens: { input: 6020, cacheWrite: 0, cacheRead: 0, output: 8051 } });
    expect(r.subtype).toBe('success');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('reads the 2.x shape with the 5m/1h split', () => {
    const r = parseClaudeJson(RESULT_V2)!;
    expect(r.metrics.cacheCreation5mTokens).toBe(20000);
    expect(r.metrics.cacheCreation1hTokens).toBe(1000);
    expect(r.metrics.model).toBe('claude-sonnet-4-6');
  });

  it('reads the last result of a stream-json array, and rejects junk', () => {
    expect(parseClaudeJson(`[{"type":"system"},${RESULT_V2}]`)!.metrics.totalCostUsd).toBe(0.1925);
    for (const bad of ['', 'not json', '{}', '{"total_cost_usd":1}', '{"total_cost_usd":"1","modelUsage":{"m":{}}}', 'null'])
      expect(parseClaudeJson(bad)).toBeNull();
  });

  it('never throws on any string (property)', () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.json()), (s) => void parseClaudeJson(s)));
  });
});

describe('plan', () => {
  const fixtures = [
    { name: 'f1', maxBudgetUsd: 0.5 },
    { name: 'f2', maxBudgetUsd: 0.5 },
    { name: 'f3', maxBudgetUsd: 0.5 },
  ];

  it('T1 phase 2 shape: 4 per task × 3 tasks = n 12, printed MDE 29.9% (t-based; 28.5% with z) at the assumed CV 0.30, cost at most USD 12', () => {
    const p = planComparison({ fixtures, runsPerTask: 4, cv: null, maxRuns: 60, monthlyVolume: 200 });
    expect(p.nPerArm).toBe(12);
    expect(p.totalRuns).toBe(24);
    expect(p.cvAssumed).toBe(true);
    expect(p.mde).toBeCloseTo(0.2989, 3);
    expect(p.expectedCostUsd).toBe(12);
    // Payback uses the t-based planned MDE (Lead decision review §9).
    expect(p.paybackMonths).toBeCloseTo(12 / (p.mde * 200), 6);
    expect(p.refusal).toBeNull();
    expect(p.capped).toBe(false);
  });

  it('expected cost never exceeds max-runs × max-budget (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 100 }), fc.double({ min: 0.01, max: 2, noNaN: true }), (k, tasks, maxRuns, b) => {
        const p = planComparison({ fixtures: fixtures.slice(0, Math.min(tasks, 3)).map((f) => ({ ...f, maxBudgetUsd: b })), runsPerTask: k, cv: 0.3, maxRuns, monthlyVolume: 100 });
        expect(p.expectedCostUsd).toBeLessThanOrEqual(maxRuns * b + 0.005);
        expect(p.capped).toBe(p.totalRuns > maxRuns);
      }),
    );
  });

  it('payback over 3 months or unknown sets a refusal (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), fc.option(fc.double({ min: 0.01, max: 1e5, noNaN: true }), { nil: null }), (k, volume) => {
        const p = planComparison({ fixtures, runsPerTask: k, cv: 0.3, maxRuns: 1000, monthlyVolume: volume });
        expect(p.refusal !== null).toBe(p.paybackMonths === null || p.paybackMonths > 3);
      }),
    );
  });

  it('plan block names MDE, expected cost, payback and the run cap', () => {
    const p = planComparison({ fixtures, runsPerTask: 30, cv: 0.3, maxRuns: 60, monthlyVolume: null });
    const text = formatPlan(p, { fixtures: 3, runsPerTask: 30, maxRuns: 60, labels: costLabels('api-key', null) }).join('\n');
    // Capped: 60 runs fit, 30 per arm; the full plan would have 90 per arm.
    expect(text).toMatch(/planned MDE: +19\.4% saving detectable at n = 30 per arm .*: the 95% CI excludes 1\.0/);
    expect(text).toMatch(/capped n: +both figures use the 30 runs per arm that fit under the run cap; the full plan \(n = 90 per arm\) would detect 11\.6%/);
    expect(text).toContain("at most USD 30.00, every run at its --max-budget-usd cap (API billing – Claude Code's client-side estimate; your bill may differ)");
    expect(text).toContain('unknown (no --monthly-volume)');
    expect(text).toContain('stops at the cap');
  });

  // Stats review 1031 follow-ups 2 and 4.
  it('measured-saving MDE reproduces the review: 39.2% at n = 12, CV 0.30, where the planned MDE is 28.5%', () => {
    expect(measuredSavingMde(0.3, 12)).toBeCloseTo(0.3924, 4);
    // By hand (review §2): 1 − 0.85 × exp(−2.80158 × 0.29356 × √(2/12)).
    expect(measuredSavingMde(0.3, 12)).toBeCloseTo(1 - 0.85 * Math.exp(-2.80158 * 0.29356 * Math.sqrt(2 / 12)), 4);
    // The plan prints t-based numbers (Lead decision): 29.9% and 40.4% at 3 × 4; the z formula above stays for §3.4.
    const p = planComparison({ fixtures, runsPerTask: 4, cv: null, maxRuns: 60, monthlyVolume: 200 });
    expect(p.mde).toBeCloseTo(minimumDetectableEffectT(0.3, 12, 18), 12);
    expect(p.mdeMeasured).toBeCloseTo(0.40406, 4);
    const text = formatPlan(p, { fixtures: 3, runsPerTask: 4, maxRuns: 60, labels: costLabels('api-key', null) }).join('\n');
    expect(text).toContain('planned MDE:      29.9% saving detectable at n = 12 per arm (CV 0.30, assumed – no pilot; α 0.05; t-based, ≈ 80% power): the 95% CI excludes 1.0');
    expect(text).toContain('measured saving:  40.4% saving needed for a "measured saving" verdict (CI upper bound ≤ 0.85) at the same n (t-based, ≈ 80% power)');
    expect(text).not.toContain('capped n:');
  });

  // values, computed independently in the review (stats-review-1031.md §9), within 0.01 percentage points.
  it.each([
    [3, 4, 40.41],
    [3, 2, 51.84],
    [3, 8, 33.34],
  ])('t-based measured-saving MDE at %i tasks × %i runs per arm, CV 0.30 = %f%% (hand-computed reference)', (K, m, ref) => {
    const n = K * m;
    const df = planDegreesOfFreedom(n, K);
    expect(df).toBe(2 * K * (m - 1));
    expect(Math.abs(100 * measuredSavingMdeT(0.3, n, df) - ref)).toBeLessThan(0.01);
  });

  it('t-based numbers: t quantiles against the t table, always above the z numbers, converging to them (property)', () => {
    expect(studentTQuantile(0.975, 18)).toBeCloseTo(2.1009, 4);
    expect(studentTQuantile(0.8, 18)).toBeCloseTo(0.8620, 4);
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 2, noNaN: true }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 2, max: 40 }), (cv, K, m) => {
        const n = K * m;
        const df = planDegreesOfFreedom(n, K);
        expect(measuredSavingMdeT(cv, n, df)).toBeGreaterThan(measuredSavingMde(cv, n));
        expect(minimumDetectableEffectT(cv, n, df)).toBeGreaterThan(minimumDetectableEffect(cv, n));
        expect(measuredSavingMdeT(cv, n, df)).toBeCloseTo(1 - 0.85 * (1 - minimumDetectableEffectT(cv, n, df)), 12);
      }),
      { numRuns: 100 },
    );
    expect(Math.abs(minimumDetectableEffectT(0.3, 50_000, 2 * (50_000 - 3)) - minimumDetectableEffect(0.3, 50_000))).toBeLessThan(1e-5);
  });

  it('the measured-saving MDE is 1 − 0.85 × (1 − planned MDE) for every CV and n (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 3, noNaN: true }), fc.integer({ min: 1, max: 5000 }), (cv, n) => {
        expect(measuredSavingMde(cv, n)).toBeCloseTo(1 - 0.85 * (1 - minimumDetectableEffect(cv, n)), 12);
        expect(measuredSavingMde(cv, n)).toBeGreaterThan(minimumDetectableEffect(cv, n));
      }),
    );
  });

  it('under --max-runs the MDE uses the runs per arm that fit, the smaller arm of the interleaved schedule', () => {
    const at = (maxRuns: number) => planComparison({ fixtures, runsPerTask: 4, cv: 0.3, maxRuns, monthlyVolume: 1000 });
    expect(at(14)).toMatchObject({ nPerArm: 7, fullNPerArm: 12, capped: true, intervalPossible: true });
    // 3 tasks, 14 runs: 7 per arm, df = 2 · (7 − 3) = 8.
    expect(at(14).mde).toBeCloseTo(minimumDetectableEffectT(0.3, 7, 8), 12);
    expect(at(14).mdeMeasured).toBeCloseTo(measuredSavingMdeT(0.3, 7, 8), 12);
    expect(at(13).nPerArm).toBe(6);
    expect(at(24)).toMatchObject({ nPerArm: 12, capped: false });
    expect(at(1)).toMatchObject({ nPerArm: 0, mde: 1, mdeMeasured: 1 });
    // The payback uses the MDE the capped plan can resolve.
    expect(at(14).paybackMonths).toBeCloseTo(at(14).expectedCostUsd / (at(14).mde * 1000), 6);
  });

  it('capped n never exceeds the full n and never gives a smaller MDE (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 200 }), (k, tasks, maxRuns) => {
        const p = planComparison({ fixtures: fixtures.slice(0, tasks), runsPerTask: k, cv: 0.3, maxRuns, monthlyVolume: 100 });
        const full = planComparison({ fixtures: fixtures.slice(0, tasks), runsPerTask: k, cv: 0.3, maxRuns: 100_000, monthlyVolume: 100 });
        expect(p.fullNPerArm).toBe(k * tasks);
        expect(p.nPerArm).toBe(Math.min(k * tasks, Math.floor(Math.min(maxRuns, 2 * k * tasks) / 2)));
        expect(p.mde).toBeGreaterThanOrEqual(full.mde - 1e-12);
        if (p.intervalPossible) expect(p.mdeMeasured).toBeGreaterThan(p.mde);
        else expect([p.mde, p.mdeMeasured]).toEqual([1, 1]);
      }),
    );
  });

  it('schedule interleaves A/B per task', () => {
    expect(runSchedule(['f1', 'f2'], 2).map((s) => `${s.fixture}:${s.arm[0]}`)).toEqual(['f1:b', 'f1:c', 'f2:b', 'f2:c', 'f1:b', 'f1:c', 'f2:b', 'f2:c']);
  });
});

describe('analysis and report', () => {
  const metrics = (cost: number, model = 'claude-opus-5-5') => ({ inputTokens: 10, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 100, outputTokens: 20, totalCostUsd: cost, durationApiMs: 1000, model });
  const runsOf = (base: number[], changed: number[]): ComparisonRecordV1['runs'] =>
    base.flatMap((b, i) => [
      { seq: 2 * i, fixture: 'f1', arm: 'baseline' as const, oracleExitCode: 0, metrics: metrics(b) },
      { seq: 2 * i + 1, fixture: 'f1', arm: 'changed' as const, oracleExitCode: 0, metrics: metrics(changed[i]!) },
    ]);

  it('a clear 50% saving is measured; excluded runs do not count', () => {
    const runs = runsOf([0.4, 0.42, 0.38, 0.41, 0.39, 0.4], [0.2, 0.21, 0.19, 0.2, 0.22, 0.2]);
    runs.push({ seq: 12, fixture: 'f1', arm: 'changed', oracleExitCode: 0, metrics: metrics(5, 'claude-haiku-4-5') });
    const a = analyzeRuns(runs, [{ seq: 12, reason: 'model-fallback' }], { seed: 7, status: 'complete' });
    expect(a.result.costRatio!).toBeCloseTo(0.5, 1);
    expect(a.result.ci95![1]).toBeLessThan(0.85);
    expect(a.verdict.code).toBe('measured-saving');
    expect(a.verdict.text).toMatch(/^Measured saving of \d+%: cost ratio 0\.5\d\d \(95% CI 0\.\d{3}–0\.\d{3}\), measured on 12 runs/);
    expect(a.result.passes).toEqual({ baseline: { passed: 6, total: 6 }, changed: { passed: 6, total: 6 } });
  });

  it('no runs → not enough evidence', () => {
    const a = analyzeRuns([], [], { seed: 1, status: 'incomplete' });
    expect(a.verdict.code).toBe('not-enough-evidence');
    expect(a.verdict.text).toMatch(/^Not enough evidence/);
    expect(a.result).toEqual({ costRatio: null, ci95: null, passes: { baseline: { passed: 0, total: 0 }, changed: { passed: 0, total: 0 } } });
  });

  it('report: verdict first, ratio, CI, passes, quality bound, measurement cost; schema-valid sample; claim rules', () => {
    const record = comparisonSample();
    expect(validateRecord(record)).toEqual([]);
    const lines = formatReport(record, { billing: 'api' });
    expect(lines[0]).toBe(recordVerdictText(record));
    const text = lines.join('\n');
    expect(text).toContain('95% CI');
    expect(text).toMatch(/passes: +baseline \d+\/\d+, changed \d+\/\d+/);
    expect(text).toMatch(/no drop larger than \d+ pp detected on your success commands/);
    const cost = measurementCost(record);
    expect(text).toContain(`measurement cost: USD ${cost.usd.toFixed(2)}`);
    expect(text).toContain(`over ${cost.runs} runs (API billing – Claude Code's client-side estimate; your bill may differ)`);
    expect(text).not.toMatch(/quality unchanged|verified quality|no quality loss|\bsafe\b|\bproves\b/i);
  });
});

// QA review of (stats-review-1031.md " review"): a plan under which some task gets fewer than 2 runs in
// an arm can never produce an interval (welchRatioCi needs 2 runs per task arm), so it must not print a finite MDE.
describe('plan without a possible interval (review)', () => {
  const fx = (k: number) => ['f1', 'f2', 'f3'].slice(0, k).map((name) => ({ name, maxBudgetUsd: 0.5 }));
  const cellCounts = (tasks: number, k: number, maxRuns: number) => {
    const counts = new Map<string, number>();
    for (const r of runSchedule(fx(tasks).map((f) => f.name), k).slice(0, maxRuns)) counts.set(`${r.fixture}/${r.arm}`, (counts.get(`${r.fixture}/${r.arm}`) ?? 0) + 1);
    return counts;
  };

  it('3 tasks, cap 10: tasks f1, f2 get 2 runs per arm, f3 only 1, so ratioCi is null and the plan is refused', () => {
    const p = planComparison({ fixtures: fx(3), runsPerTask: 4, cv: 0.3, maxRuns: 10, monthlyVolume: 1000 });
    expect(p).toMatchObject({ nPerArm: 5, capped: true, intervalPossible: false, mde: 1, mdeMeasured: 1, paybackMonths: null });
    expect(p.refusal).toContain('--max-runs ≥ 12');
    // The engine agrees: those run counts give no interval for any costs.
    const counts = cellCounts(3, 4, 10);
    const tasks = fx(3).map((f, i) => ({
      task: f.name,
      baseline: Array.from({ length: counts.get(`${f.name}/baseline`)! }, (_, j) => 1 + 0.1 * (i + j)),
      changed: Array.from({ length: counts.get(`${f.name}/changed`)! }, (_, j) => 0.5 + 0.1 * (i + j)),
    }));
    expect(ratioCi(tasks, { seed: 1, resamples: 200 })).toBeNull();
    const text = formatPlan(p, { fixtures: 3, runsPerTask: 4, maxRuns: 10, labels: costLabels('api-key', null) }).join('\n');
    expect(text).toContain('planned MDE:      none – some task gets fewer than 2 runs per arm');
    expect(text).not.toContain('measured saving:');
    expect(text).not.toContain('capped n:');
  });

  it('runs per arm 1 is refused even without a cap; cap exactly 4 per task is the threshold (±1)', () => {
    expect(planComparison({ fixtures: fx(3), runsPerTask: 1, cv: 0.3, maxRuns: 60, monthlyVolume: 1000 })).toMatchObject({ intervalPossible: false, mde: 1 });
    expect(planComparison({ fixtures: fx(3), runsPerTask: 4, cv: 0.3, maxRuns: 11, monthlyVolume: 1000 }).intervalPossible).toBe(false);
    const at12 = planComparison({ fixtures: fx(3), runsPerTask: 4, cv: 0.3, maxRuns: 12, monthlyVolume: 1000 });
    expect(at12).toMatchObject({ intervalPossible: true, nPerArm: 6 });
    expect(at12.mde).toBeCloseTo(minimumDetectableEffectT(0.3, 6, 6), 12); // t-based, df = 2 · 3 · (2 − 1)
    expect(planComparison({ fixtures: fx(1), runsPerTask: 4, cv: 0.3, maxRuns: 4, monthlyVolume: 1000 }).intervalPossible).toBe(true);
    expect(planComparison({ fixtures: fx(1), runsPerTask: 4, cv: 0.3, maxRuns: 3, monthlyVolume: 1000 }).intervalPossible).toBe(false);
  });

  it('an interval is possible exactly when runs per arm ≥ 2 and the cap holds 4 runs per task; otherwise refused with MDE 1 (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 40 }), (k, tasks, maxRuns) => {
        const p = planComparison({ fixtures: fx(tasks), runsPerTask: k, cv: 0.3, maxRuns, monthlyVolume: 1e6 });
        const counts = cellCounts(tasks, k, maxRuns);
        const minCell = Math.min(...fx(tasks).flatMap((f) => ['baseline', 'changed'].map((a) => counts.get(`${f.name}/${a}`) ?? 0)));
        expect(p.intervalPossible).toBe(k >= 2 && maxRuns >= 4 * tasks);
        expect(p.intervalPossible).toBe(minCell >= 2);
        if (!p.intervalPossible) expect(p).toMatchObject({ mde: 1, mdeMeasured: 1, paybackMonths: null });
        expect(p.refusal === null).toBe(p.intervalPossible && p.paybackMonths !== null && p.paybackMonths <= 3);
      }),
    );
  });
});

// Model pin per arm: a model change between the arms is the change under test, never a fallback.
describe('isModelFallback: the model is pinned per arm', () => {
  it('two arms on different models: nothing is a fallback, both models are pinned', () => {
    const pins: ModelByArm = {};
    const seq: [Arm, string][] = [['baseline', 'claude-opus-5-5'], ['changed', 'claude-sonnet-5-5'], ['baseline', 'claude-opus-5-5'], ['changed', 'claude-sonnet-5-5']];
    expect(seq.map(([arm, m]) => isModelFallback(pins, arm, m))).toEqual([false, false, false, false]);
    expect(pins).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' });
  });

  it('a mid-arm model change is still a fallback, in either arm', () => {
    const pins: ModelByArm = {};
    expect(isModelFallback(pins, 'baseline', 'claude-opus-5-5')).toBe(false);
    expect(isModelFallback(pins, 'changed', 'claude-sonnet-5-5')).toBe(false);
    expect(isModelFallback(pins, 'changed', 'claude-haiku-4-5')).toBe(true);
    expect(isModelFallback(pins, 'baseline', 'claude-sonnet-5-5')).toBe(true);
    expect(pins).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' });
  });

  it('property: over any run sequence, a run is a fallback exactly when its model differs from its own arm\'s first model, and one arm never affects the other', () => {
    const model = fc.constantFrom('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5');
    const run = fc.record({ arm: fc.constantFrom<Arm>('baseline', 'changed'), model });
    fc.assert(
      fc.property(fc.array(run, { maxLength: 40 }), (runs) => {
        const pins: ModelByArm = {};
        const flags = runs.map((r) => isModelFallback(pins, r.arm, r.model));
        for (const arm of ['baseline', 'changed'] as const) {
          const own = runs.map((r, i) => ({ ...r, i })).filter((r) => r.arm === arm);
          expect(pins[arm]).toBe(own[0]?.model);
          for (const r of own) expect(flags[r.i]).toBe(r.model !== own[0]!.model);
          // Independence: the arm alone gives the same flags as the interleaved sequence.
          const alone: ModelByArm = {};
          expect(own.map((r) => isModelFallback(alone, arm, r.model))).toEqual(own.map((r) => flags[r.i]));
        }
      }),
      { numRuns: 300 },
    );
  });

  // QA review §11 ruling 1: the planned model anchors the pin.
  it('plannedModelMatcher: aliases match their family, full ids match themselves or a dated variant, others → null', () => {
    const opus = plannedModelMatcher('opus')!;
    expect(['claude-opus-5-5', 'claude-opus-4-1-20250805', 'us.anthropic.claude-opus-5-5-v1:0'].map(opus)).toEqual([true, true, true]);
    expect(['claude-sonnet-5-5', 'claude-haiku-4-5', 'opusx'].map(opus)).toEqual([false, false, false]);
    expect(plannedModelMatcher('sonnet[1m]')!('claude-sonnet-5-5')).toBe(true);
    const id = plannedModelMatcher('claude-opus-5-5')!;
    expect([id('claude-opus-5-5'), id('claude-opus-5-5-20261101'), id('claude-opus-5'), id('claude-sonnet-5-5')]).toEqual([true, true, false, false]);
    for (const v of [null, '', 'opusplan', 'default', 'best', 'arn:aws:bedrock:x']) expect(plannedModelMatcher(v)).toBeNull();
  });

  it('a first run off the planned model is a fallback and does not pin; without a plan the old rule holds', () => {
    const plan = plannedModelMatcher('opus');
    const pins: ModelByArm = {};
    expect(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'].map((m) => isModelFallback(pins, 'baseline', m, plan))).toEqual([true, false, false, true]);
    expect(pins.baseline).toBe('claude-opus-5-5');
    const old: ModelByArm = {};
    expect(isModelFallback(old, 'baseline', 'claude-sonnet-5-5', null)).toBe(false);
    expect(old.baseline).toBe('claude-sonnet-5-5');
  });

  it('property: with a planned model, the pin always fits the plan, every off-plan run is excluded, and no on-plan run equal to the pin is', () => {
    const model = fc.constantFrom('claude-opus-5-5', 'claude-opus-4-1', 'claude-sonnet-5-5', 'claude-haiku-4-5');
    fc.assert(
      fc.property(fc.constantFrom('opus', 'sonnet', 'haiku', 'claude-opus-5-5'), fc.array(model, { maxLength: 30 }), (cfg, ms) => {
        const plan = plannedModelMatcher(cfg)!;
        const pins: ModelByArm = {};
        const flags = ms.map((m) => isModelFallback(pins, 'changed', m, plan));
        const firstOnPlan = ms.find(plan);
        expect(pins.changed).toBe(firstOnPlan);
        ms.forEach((m, i) => expect(flags[i]).toBe(!plan(m) || m !== firstOnPlan));
      }),
      { numRuns: 300 },
    );
  });

  // Ruling 2: any prefix of the interleaved schedule (a run cap or Ctrl-C) leaves the arms balanced up to one run,
  // in at most one task, and that task's extra run is a baseline run.
  it('property: every prefix of runSchedule is balanced per task up to one baseline run in at most one task', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 8 }), fc.nat(), (tasks, r, k) => {
        const names = Array.from({ length: tasks }, (_, i) => `t${i}`);
        const full = runSchedule(names, r);
        const prefix = full.slice(0, k % (full.length + 1));
        const diffs = names.map((n) => prefix.filter((s) => s.fixture === n && s.arm === 'baseline').length - prefix.filter((s) => s.fixture === n && s.arm === 'changed').length);
        expect(diffs.every((d) => d === 0 || d === 1)).toBe(true);
        expect(diffs.filter((d) => d === 1).length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('modelByArmText names each arm, or one model for both', () => {
    expect(modelByArmText({ baseline: 'a', changed: 'b' })).toBe('baseline a, changed b');
    expect(modelByArmText({ baseline: 'a', changed: 'a' })).toBe('a (both arms)');
    expect(modelByArmText({ changed: 'b' })).toBe('changed b');
    expect(modelByArmText({})).toBeNull();
    expect(modelByArmText(undefined)).toBeNull();
  });

  it('the report shows the model per arm when the record has it, else the single model (older records)', () => {
    const old = comparisonSample();
    expect(formatReport(old, { billing: 'api' }).find((l) => l.includes('pinned:'))).toContain(`model ${old.versions.model};`);
    const rec = { ...old, versions: { ...old.versions, modelByArm: { baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' } } };
    expect(formatReport(rec, { billing: 'api' }).find((l) => l.includes('pinned:'))).toContain('model baseline claude-opus-5-5, changed claude-sonnet-5-5;');
  });

  it('the plan shows the configured model per arm, with the Claude Code default when unset', () => {
    const plan = planComparison({ fixtures: [{ name: 'f', maxBudgetUsd: 0.5 }], runsPerTask: 4, cv: null, maxRuns: 60, monthlyVolume: 1000 });
    const labels = costLabels('api-key', 'api');
    const line = formatPlan(plan, { fixtures: 1, runsPerTask: 4, maxRuns: 60, labels, configuredModels: { baseline: null, changed: 'claude-sonnet-5-5' } }).find((l) => l.includes('model per arm:'));
    expect(line).toContain('baseline your Claude Code default, changed claude-sonnet-5-5');
    expect(formatPlan(plan, { fixtures: 1, runsPerTask: 4, maxRuns: 60, labels }).some((l) => l.includes('model per arm:'))).toBe(false);
  });
});

// item 1 (stats review §11 item 2): informative censoring. A record the user interrupted is at most "likely saving";
// a stop that does not depend on the outcomes keeps the verdict.
describe('verdict of an interrupted record', () => {
  const metrics = (cost: number) => ({ inputTokens: 10, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 100, outputTokens: 20, totalCostUsd: cost, durationApiMs: 1000, model: 'claude-opus-5-5' });
  const STOPS: (StopReason | undefined)[] = [undefined, 'run-cap', 'claude-code-version', 'error', 'interrupted'];
  /** Runs of 1-3 tasks, 2-6 per arm each, changed cost = baseline × ratio × noise (both arms log-normal noise). */
  const runsArb = fc
    .record({
      tasks: fc.integer({ min: 1, max: 3 }),
      perArm: fc.integer({ min: 2, max: 6 }),
      ratio: fc.double({ min: 0.2, max: 1.3, noNaN: true }),
      noise: fc.double({ min: 0, max: 0.4, noNaN: true }),
      seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
    })
    .map(({ tasks, perArm, ratio, noise, seed }) => {
      let x = seed;
      const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
      const runs: ComparisonRecordV1['runs'] = [];
      let seq = 0;
      for (let t = 0; t < tasks; t++)
        for (let i = 0; i < perArm; i++)
          for (const arm of ['baseline', 'changed'] as const) {
            const base = 0.4 * (1 + t) * Math.exp(noise * (rand() - 0.5));
            runs.push({ seq: seq++, fixture: `t${t}`, arm, oracleExitCode: 0, metrics: metrics(arm === 'baseline' ? base : base * ratio) });
          }
      return { runs, seed };
    });

  it('capVerdictForStop: only an interrupted measured saving changes, to likely saving', () => {
    for (const stop of STOPS)
      for (const code of ['measured-saving', 'likely-saving', 'not-enough-evidence'] as const)
        expect(capVerdictForStop(code, stop)).toBe(stop === 'interrupted' && code === 'measured-saving' ? 'likely-saving' : code);
  });

  it('a clear 50% saving stopped by an interrupt is "likely saving" and says so; the same runs capped stay measured (failing before)', () => {
    const runs = Array.from({ length: 6 }, (_, i) => [
      { seq: 2 * i, fixture: 'f1', arm: 'baseline' as const, oracleExitCode: 0, metrics: metrics([0.4, 0.42, 0.38, 0.41, 0.39, 0.4][i]!) },
      { seq: 2 * i + 1, fixture: 'f1', arm: 'changed' as const, oracleExitCode: 0, metrics: metrics([0.2, 0.21, 0.19, 0.2, 0.22, 0.2][i]!) },
    ]).flat();
    expect(analyzeRuns(runs, [], { seed: 7, status: 'incomplete', stop: 'run-cap' }).verdict.code).toBe('measured-saving');
    const a = analyzeRuns(runs, [], { seed: 7, status: 'incomplete', stop: 'interrupted' });
    expect(a.verdict.code).toBe('likely-saving');
    expect(a.verdict.text).toMatch(/^Likely saving, not proven: cost ratio 0\.\d{3} \(95% CI .*\), measured on 12 runs of your fixtures, incomplete – interrupted\.$/);
  });

  it('property: an interrupted record is never "measured saving"; it equals the uncapped verdict otherwise; other stops never change the verdict; the stored record re-derives the same text', () => {
    fc.assert(
      fc.property(runsArb, fc.constantFrom(...STOPS), ({ runs, seed }, stop) => {
        const plain = analyzeRuns(runs, [], { seed, resamples: 300, status: stop ? 'incomplete' : 'complete' });
        const a = analyzeRuns(runs, [], { seed, resamples: 300, status: stop ? 'incomplete' : 'complete', ...(stop ? { stop } : {}) });
        expect(a.result).toEqual(plain.result);
        if (stop === 'interrupted') {
          expect(a.verdict.code).not.toBe('measured-saving');
          expect(a.verdict.code).toBe(plain.verdict.code === 'measured-saving' ? 'likely-saving' : plain.verdict.code);
          expect(a.verdict.text).not.toMatch(/^Measured saving/);
        } else expect(a.verdict.code).toBe(plain.verdict.code);
        const record = { ...comparisonSample(), runs, exclusions: [], status: stop ? ('incomplete' as const) : ('complete' as const), ...(stop ? { stop } : {}), result: a.result, verdict: a.verdict };
        expect(validateRecord(record)).toEqual([]);
        expect(recordVerdictText(record)).toBe(a.verdict.text);
      }),
      { numRuns: 150 },
    );
  });

  it('schema: `stop` is optional (older records stay valid) and only takes the four reasons', () => {
    const rec = comparisonSample();
    expect(rec.stop).toBeUndefined();
    expect(validateRecord(rec)).toEqual([]);
    expect(validateRecord({ ...rec, schemaVersion: '1.3.0' })).toEqual([]);
    expect(validateRecord({ ...rec, status: 'incomplete', stop: 'interrupted' })).toEqual([]);
    expect(validateRecord({ ...rec, status: 'incomplete', stop: 'ctrl-c' })).not.toEqual([]);
  });
});

// item 2: the model pin is per (arm, fixture). Fixtures of one arm on different configured models are measured;
// a model change within one (arm, fixture) is still a fallback.
describe('isModelFallback per (arm, fixture)', () => {
  it('two fixtures of one arm on different models: none is a fallback; a change within one fixture is', () => {
    const pins: Record<string, string> = {};
    const seq: [Arm, string, string][] = [
      ['baseline', 'f1', 'claude-opus-5-5'],
      ['baseline', 'f2', 'claude-sonnet-5-5'],
      ['changed', 'f1', 'claude-opus-5-5'],
      ['changed', 'f2', 'claude-sonnet-5-5'],
      ['baseline', 'f2', 'claude-sonnet-5-5'],
      ['baseline', 'f2', 'claude-haiku-4-5'],
      ['baseline', 'f1', 'claude-opus-5-5'],
    ];
    expect(seq.map(([arm, f, m]) => isModelFallback(pins, modelPinKey(arm, f), m))).toEqual([false, false, false, false, false, true, false]);
    expect(pins).toEqual({ 'baseline/f1': 'claude-opus-5-5', 'baseline/f2': 'claude-sonnet-5-5', 'changed/f1': 'claude-opus-5-5', 'changed/f2': 'claude-sonnet-5-5' });
  });

  it('each (arm, fixture) has its own planned model', () => {
    const plan: Record<string, ReturnType<typeof plannedModelMatcher>> = { 'baseline/f1': plannedModelMatcher('opus'), 'baseline/f2': plannedModelMatcher('sonnet') };
    const pins: Record<string, string> = {};
    const flag = (f: string, m: string) => isModelFallback(pins, modelPinKey('baseline', f), m, plan[modelPinKey('baseline', f)]);
    expect([flag('f1', 'claude-sonnet-5-5'), flag('f2', 'claude-sonnet-5-5'), flag('f1', 'claude-opus-5-5'), flag('f2', 'claude-opus-5-5')]).toEqual([true, false, false, true]);
  });

  it('property: over generated run sequences, a run is a fallback exactly when its model differs from the first (on-plan) model of its own (arm, fixture), and keys never affect each other', () => {
    const model = fc.constantFrom('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5');
    const run = fc.record({ arm: fc.constantFrom<Arm>('baseline', 'changed'), fixture: fc.constantFrom('f1', 'f2', 'f3'), model });
    const cfg = fc.option(fc.constantFrom('opus', 'sonnet', 'haiku'), { nil: null });
    fc.assert(
      fc.property(fc.array(run, { maxLength: 40 }), fc.dictionary(fc.constantFrom('baseline/f1', 'baseline/f2', 'baseline/f3', 'changed/f1', 'changed/f2', 'changed/f3'), cfg), (runs, configured) => {
        const planOf = (key: string) => plannedModelMatcher(configured[key] ?? null);
        const pins: Record<string, string> = {};
        const flags = runs.map((r) => isModelFallback(pins, modelPinKey(r.arm, r.fixture), r.model, planOf(modelPinKey(r.arm, r.fixture))));
        const keys = new Set(runs.map((r) => modelPinKey(r.arm, r.fixture)));
        for (const key of keys) {
          const own = runs.map((r, i) => ({ ...r, i })).filter((r) => modelPinKey(r.arm, r.fixture) === key);
          const plan = planOf(key);
          const first = own.find((r) => !plan || plan(r.model))?.model;
          expect(pins[key]).toBe(first);
          for (const r of own) expect(flags[r.i]).toBe((plan !== null && !plan(r.model)) || r.model !== first);
          // Independence: the key alone gives the same flags as the interleaved sequence.
          const alone: Record<string, string> = {};
          expect(own.map((r) => isModelFallback(alone, key, r.model, plan))).toEqual(own.map((r) => flags[r.i]));
        }
      }),
      { numRuns: 300 },
    );
  });
});

// QA review: the key choice itself. Fixtures with the same configured model (or none) share one pin group;
// only a different configuration or the other arm gives another key.
describe('modelPinKeyFor: the pin group is the arm plus the configured model (review)', () => {
  it('equal configurations, including none, share a key; another value or arm does not', () => {
    expect(modelPinKeyFor('baseline', null)).toBe(modelPinKeyFor('baseline', undefined));
    expect(modelPinKeyFor('baseline', 'opus')).toBe(modelPinKeyFor('baseline', 'opus'));
    expect(modelPinKeyFor('baseline', 'opus')).not.toBe(modelPinKeyFor('baseline', 'sonnet'));
    expect(modelPinKeyFor('baseline', null)).not.toBe(modelPinKeyFor('baseline', 'null'));
    expect(modelPinKeyFor('baseline', 'opus')).not.toBe(modelPinKeyFor('changed', 'opus'));
  });

  it('two unconfigured fixtures: a fallback on the second fixture\'s first run is caught by the shared pin', () => {
    const pins: Record<string, string> = {};
    const runs: [string, string][] = [['f1', 'claude-opus-5-5'], ['f2', 'claude-sonnet-5-5'], ['f2', 'claude-opus-5-5'], ['f1', 'claude-opus-5-5']];
    const configured: Record<string, string | null> = { f1: null, f2: null };
    expect(runs.map(([f, m]) => isModelFallback(pins, modelPinKeyFor('baseline', configured[f]), m))).toEqual([false, true, false, false]);
  });

  it('property: two (arm, configured model) pairs get the same key exactly when both parts are equal', () => {
    const cfg = fc.option(fc.oneof(fc.constantFrom('opus', 'sonnet', 'null', '"x"', 'a/b'), fc.string({ maxLength: 12 })), { nil: null });
    const arm = fc.constantFrom<Arm>('baseline', 'changed');
    fc.assert(
      fc.property(arm, cfg, arm, cfg, (a1, c1, a2, c2) => {
        expect(modelPinKeyFor(a1, c1) === modelPinKeyFor(a2, c2)).toBe(a1 === a2 && c1 === c2);
      }),
      { numRuns: 500 },
    );
  });
});

// QA review, Lead decision: an incomplete record without `stop` (before schema 1.4.0) may have been
// interrupted, so `report` caps its verdict too; a complete record without `stop` keeps it.
describe('verdict of an incomplete record without `stop` (review)', () => {
  const metrics = (cost: number) => ({ inputTokens: 10, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 100, outputTokens: 20, totalCostUsd: cost, durationApiMs: 1000, model: 'claude-opus-5-5' });
  const runs = Array.from({ length: 6 }, (_, i) => [
    { seq: 2 * i, fixture: 'f1', arm: 'baseline' as const, oracleExitCode: 0, metrics: metrics([0.4, 0.42, 0.38, 0.41, 0.39, 0.4][i]!) },
    { seq: 2 * i + 1, fixture: 'f1', arm: 'changed' as const, oracleExitCode: 0, metrics: metrics([0.2, 0.21, 0.19, 0.2, 0.22, 0.2][i]!) },
  ]).flat();
  const a = analyzeRuns(runs, [], { seed: 7, status: 'incomplete' });
  const record = (status: 'complete' | 'incomplete', stop?: StopReason) => ({ ...comparisonSample(), schemaVersion: '1.3.0', runs, exclusions: [], status, ...(stop ? { stop } : {}), result: a.result, verdict: a.verdict });

  it('incomplete without stop → "likely saving"; complete without stop and incomplete with run-cap → measured', () => {
    expect(a.verdict.code).toBe('measured-saving');
    expect(recordVerdictText(record('incomplete'))).toMatch(/^Likely saving, not proven: .*, incomplete\.$/);
    expect(recordVerdictText(record('complete'))).toMatch(/^Measured saving of/);
    expect(recordVerdictText(record('incomplete', 'run-cap'))).toMatch(/^Measured saving of/);
    expect(formatReport(record('incomplete'), { billing: 'api' })[0]).toMatch(/^Likely saving/);
  });
});
