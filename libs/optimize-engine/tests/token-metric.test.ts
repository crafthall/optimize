// Token-use verdict of `compare` (R1-19). Property: the token ratio equals a hand-computed geometric mean of
// token use (input + cache write + cache read + output, summed over models) on generated runs; the verdict thresholds
// are the same function for both metrics. Differential: `metric: 'cost'` gives exactly the pre- analysis, verdict
// and report (golden outputs generated from main@6148cfd8, tests/fixtures/metric-cost-golden.json). Older records
// (no `metric`) validate and report as cost.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analyzeRuns,
  claimViolations,
  componentRatios,
  costLabels,
  defaultMetric,
  formatPlan,
  formatReport,
  modelUsageTokens,
  parseClaudeJson,
  planComparison,
  printedVerdictCode,
  recordMetric,
  recordVerdictText,
  runTokens,
  taskValues,
  validateRecord,
  type ComparisonRecordV1,
} from '../src/index';
import { validComparison } from './samples';

type Run = ComparisonRecordV1['runs'][number];
type Comp = { input: number; cacheWrite: number; cacheRead: number; output: number };

// Top-level usage fields are 0, so a run whose per-model sum is 0 has no tokens at all after the usage fallback
// (Lead follow-up 2) and stays uncounted; the fallback itself is tested on its own below.
const metrics = (cost: number, c: Comp, model = 'claude-opus-5-5'): Run['metrics'] => ({
  inputTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  totalCostUsd: cost,
  durationApiMs: 1000,
  model,
  modelUsageTokens: c,
});

const someTokens = fc.record({ input: fc.integer({ min: 0, max: 200_000 }), cacheWrite: fc.integer({ min: 0, max: 200_000 }), cacheRead: fc.integer({ min: 0, max: 2_000_000 }), output: fc.integer({ min: 0, max: 100_000 }) });
// QA review: a run with zero token use must be reachable, or "zero-token runs are not counted" is never tested
// (with four independent integers an all-zero run has probability ~1e-20).
const comp = fc.oneof({ arbitrary: someTokens, weight: 5 }, { arbitrary: fc.constant({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }), weight: 1 });
const runSet = fc
  .array(fc.record({ task: fc.integer({ min: 0, max: 2 }), arm: fc.constantFrom('baseline' as const, 'changed' as const), c: comp, cost: fc.double({ min: 0.001, max: 5, noNaN: true }), excluded: fc.boolean() }), { minLength: 1, maxLength: 30 })
  .map((xs) => {
    const runs: Run[] = xs.map((x, seq) => ({ seq, fixture: `t${x.task}`, arm: x.arm, oracleExitCode: 0, metrics: metrics(x.cost, x.c) }));
    const exclusions = xs.flatMap((x, seq) => (x.excluded && seq % 3 === 0 ? [{ seq, reason: 'model-fallback' as const }] : []));
    return { runs, exclusions };
  });

/** Hand-computed reference: per task, mean ln(token use) changed − baseline; mean over tasks with both arms; exp. */
function referenceTokenRatio(runs: readonly Run[], exclusions: readonly { seq: number }[]): number | null {
  const out = new Set(exclusions.map((e) => e.seq));
  const logs = new Map<string, { baseline: number[]; changed: number[] }>();
  for (const r of runs) {
    const c = r.metrics.modelUsageTokens!;
    const total = c.input + c.cacheWrite + c.cacheRead + c.output;
    if (out.has(r.seq) || total <= 0) continue;
    const t = logs.get(r.fixture) ?? { baseline: [], changed: [] };
    t[r.arm].push(Math.log(total));
    logs.set(r.fixture, t);
  }
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const d = [...logs.values()].filter((t) => t.baseline.length && t.changed.length).map((t) => m(t.changed) - m(t.baseline));
  return d.length ? Math.exp(m(d)) : null;
}

describe('token metric (#1165)', () => {
  it('modelUsage tokens are summed over every model; cache write is cacheCreationInputTokens (5m + 1h)', () => {
    expect(
      modelUsageTokens({
        'claude-opus-5-5': { inputTokens: 100, cacheCreationInputTokens: 2000, cacheReadInputTokens: 30000, outputTokens: 400, costUSD: 1 },
        'claude-haiku-4-5': { inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40, costUSD: 0.01 },
        junk: 'not an object',
      }),
    ).toEqual({ input: 110, cacheWrite: 2020, cacheRead: 30030, output: 440 });
    expect(modelUsageTokens(null)).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    const r = parseClaudeJson(JSON.stringify({ total_cost_usd: 0.5, modelUsage: { 'claude-opus-5-5': { inputTokens: 5, cacheCreationInputTokens: 6, cacheReadInputTokens: 7, outputTokens: 8, costUSD: 0.5 } } }))!;
    expect(runTokens(r.metrics)).toBe(26);
  });

  it('a record run without modelUsageTokens (before schema 1.5.0) uses the top-level usage fields', () => {
    const m = { ...metrics(1, { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }) };
    delete m.modelUsageTokens;
    expect(runTokens({ ...m, inputTokens: 1, cacheCreation5mTokens: 2, cacheCreation1hTokens: 3, cacheReadTokens: 4, outputTokens: 5 })).toBe(15);
  });

  it('a per-model sum of 0 (modelUsage without token fields) falls back to the top-level usage fields, so the run is counted (Lead follow-up 2)', () => {
    const r = parseClaudeJson(JSON.stringify({ total_cost_usd: 0.5, usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }, modelUsage: { 'claude-opus-5-5': { costUSD: 0.5 } } }))!;
    expect(r.metrics.modelUsageTokens).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(runTokens(r.metrics)).toBe(100);
    const runs: Run[] = [0, 1, 2, 3].map((seq) => ({ seq, fixture: 'f', arm: seq % 2 ? 'changed' : 'baseline', oracleExitCode: 0, metrics: r.metrics }));
    expect(taskValues(runs, [], 'tokens')).toEqual([{ task: 'f', baseline: [100, 100], changed: [100, 100] }]);
  });

  it('default metric: tokens for subscription and credits, cost for api and unset', () => {
    expect(defaultMetric('subscription')).toBe('tokens');
    expect(defaultMetric('credits')).toBe('tokens');
    expect(defaultMetric('api')).toBe('cost');
    expect(defaultMetric('unset')).toBe('cost');
    expect(defaultMetric(null)).toBe('cost');
  });

  it('property: the token ratio equals the hand-computed geometric mean of token use on generated runs', () => {
    fc.assert(
      fc.property(runSet, ({ runs, exclusions }) => {
        const a = analyzeRuns(runs, exclusions, { seed: 3, resamples: 200, status: 'complete', metric: 'tokens' });
        const ref = referenceTokenRatio(runs, exclusions);
        if (ref === null) expect(a.result.costRatio).toBeNull();
        else expect(Math.abs(a.result.costRatio! / ref - 1)).toBeLessThan(1e-9);
      }),
      { numRuns: 300 },
    );
  });

  it('property: verdict thresholds are identical for both metrics – token use proportional to cost gives the same ratio, CI and verdict', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ task: fc.integer({ min: 0, max: 2 }), arm: fc.constantFrom('baseline' as const, 'changed' as const), k: fc.integer({ min: 1, max: 5000 }) }), { minLength: 4, maxLength: 24 }),
        fc.integer({ min: 1, max: 1000 }),
        (xs, seed) => {
          // tokens = 1000·k exactly, cost = k / 1000: the two metrics differ by a constant factor only.
          const runs: Run[] = xs.map((x, seq) => ({ seq, fixture: `t${x.task}`, arm: x.arm, oracleExitCode: 0, metrics: metrics(x.k / 1000, { input: 1000 * x.k, cacheWrite: 0, cacheRead: 0, output: 0 }) }));
          const cost = analyzeRuns(runs, [], { seed, resamples: 300, status: 'complete', metric: 'cost' });
          const tok = analyzeRuns(runs, [], { seed, resamples: 300, status: 'complete', metric: 'tokens' });
          if (cost.result.costRatio === null) {
            expect(tok.result.costRatio).toBeNull();
            return;
          }
          expect(Math.abs(tok.result.costRatio! / cost.result.costRatio - 1)).toBeLessThan(1e-9);
          if (cost.result.ci95) for (const i of [0, 1]) expect(Math.abs(tok.result.ci95![i]! / cost.result.ci95[i]! - 1)).toBeLessThan(1e-9);
          // The verdict is the same function of (ratio, CI) for both metrics.
          expect(printedVerdictCode(tok.result.costRatio, tok.result.ci95)).toBe(tok.verdict.code);
          expect(tok.verdict.code).toBe(cost.verdict.code);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('hand-computed example: two tasks, token ratio = sqrt(1075/1150 × 1450/4220) = 0.566739', () => {
    const c = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ input, cacheWrite, cacheRead, output });
    const runs: Run[] = [
      { seq: 0, fixture: 'a', arm: 'baseline', oracleExitCode: 0, metrics: metrics(1, c(100, 0, 1000, 50)) }, // 1150
      { seq: 1, fixture: 'a', arm: 'changed', oracleExitCode: 0, metrics: metrics(1, c(50, 0, 1000, 25)) }, // 1075
      { seq: 2, fixture: 'b', arm: 'baseline', oracleExitCode: 0, metrics: metrics(1, c(200, 10, 4000, 10)) }, // 4220
      { seq: 3, fixture: 'b', arm: 'changed', oracleExitCode: 0, metrics: metrics(1, c(400, 10, 1000, 40)) }, // 1450
      { seq: 4, fixture: 'b', arm: 'changed', oracleExitCode: 0, metrics: metrics(1, c(0, 0, 0, 0)) }, // zero token use: not counted
    ];
    const a = analyzeRuns(runs, [], { seed: 1, resamples: 200, status: 'complete', metric: 'tokens' });
    expect(a.result.costRatio).toBeCloseTo(0.566739, 6);
    expect(taskValues(runs, [], 'tokens').map((t) => [t.baseline, t.changed])).toEqual([[[1150], [1075]], [[4220], [1450]]]);
  });

  it('component ratios: per-task mean ratio, geometric mean over tasks; zero in an arm → not computable', () => {
    const c = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ input, cacheWrite, cacheRead, output });
    const runs: Run[] = [
      { seq: 0, fixture: 'a', arm: 'baseline', oracleExitCode: 0, metrics: metrics(1, c(100, 0, 1000, 50)) },
      { seq: 1, fixture: 'a', arm: 'changed', oracleExitCode: 0, metrics: metrics(1, c(50, 0, 1000, 25)) },
      { seq: 2, fixture: 'b', arm: 'baseline', oracleExitCode: 0, metrics: metrics(1, c(200, 10, 4000, 10)) },
      { seq: 3, fixture: 'b', arm: 'changed', oracleExitCode: 0, metrics: metrics(1, c(400, 10, 1000, 40)) },
    ];
    const r = componentRatios(runs, []);
    expect(r.input).toBeCloseTo(Math.sqrt(0.5 * 2), 12);
    expect(r.cacheWrite).toBe(1); // only task b has cache writes in both arms
    expect(r.cacheRead).toBeCloseTo(Math.sqrt(1 * 0.25), 12);
    expect(r.output).toBeCloseTo(Math.sqrt(0.5 * 4), 12);
    expect(componentRatios(runs.slice(0, 2), []).cacheWrite).toBeNull();
  });

  it('report in tokens: token wording, no currency in any token result line, component lines, claim rules hold', () => {
    const runs: Run[] = [];
    for (let i = 0; i < 6; i++) {
      runs.push({ seq: 2 * i, fixture: 'calc-core-rounding', arm: 'baseline', oracleExitCode: 0, metrics: metrics(0.4, { input: 1000 + i, cacheWrite: 2000, cacheRead: 40000 + 100 * i, output: 900 }) });
      runs.push({ seq: 2 * i + 1, fixture: 'calc-core-rounding', arm: 'changed', oracleExitCode: 0, metrics: metrics(0.4, { input: 1000, cacheWrite: 2000, cacheRead: 20000 + 50 * i, output: 450 }) });
    }
    for (const billing of ['subscription', 'credits', 'api'] as const) {
      const analysis = analyzeRuns(runs, [], { seed: 9, resamples: 500, status: 'complete', metric: 'tokens' });
      const record: ComparisonRecordV1 = { ...validComparison(), schemaVersion: '1.5.0', metric: 'tokens', labels: costLabels('subscription', billing), runs, exclusions: [], ...analysis };
      expect(validateRecord(record)).toEqual([]);
      const lines = formatReport(record);
      expect(lines[0]).toMatch(/^Measured saving of \d+% in token use: token ratio 0\.\d{3} \(95% CI 0\.\d{3}–0\.\d{3}\), measured on 12 runs of your fixtures\.$/);
      const text = lines.join('\n');
      expect(text).toMatch(/token ratio: +0\.\d{3} changed ÷ baseline, 95% CI/);
      expect(text).not.toMatch(/cost ratio/);
      for (const name of ['input', 'cache write', 'cache read', 'output']) expect(text).toMatch(new RegExp(`  ${name}: +\\d\\.\\d{3} changed ÷ baseline – descriptive only, no interval, no verdict`));
      expect(text).toContain("token use – raw count of input, cache write (5m + 1h), cache read and output tokens, summed over every model of the run; cache reads count at full weight (how your plan's limit weighs token kinds is not published");
      for (const l of lines.filter((l) => /token ratio|in token use|changed ÷ baseline/.test(l))) expect(l).not.toMatch(/USD|\$/);
      expect(claimViolations(lines, { labels: record.labels!, report: true, metric: 'tokens' })).toEqual([]);
      expect(recordVerdictText(record)).toBe(lines[0]);
      const total = runs.reduce((acc, r) => acc + runTokens(r.metrics), 0);
      expect(text).toContain(`and ${total.toLocaleString('en-US')} tokens over 12 runs`);
    }
  });

  it('claim rule: a currency amount in a token-use result line is a violation', () => {
    const labels = costLabels('subscription', 'subscription');
    const v = claimViolations(['Measured saving of 30% in token use: token ratio 0.700 (95% CI 0.6–0.8), measured on 12 runs of your fixtures, USD 1.20.'], { labels, report: true, metric: 'tokens' });
    expect(v.some((x) => x.startsWith('currency amount in a token-use result'))).toBe(true);
  });

  it('plan in tokens: token wording, same MDE numbers as cost (the CV is the token CV)', () => {
    const fixtures = [{ name: 'a', maxBudgetUsd: 0.5 }];
    const plan = planComparison({ fixtures, runsPerTask: 4, cv: 0.25, maxRuns: 60, monthlyVolume: 1000 });
    const labels = costLabels('subscription', 'subscription');
    const tok = formatPlan(plan, { fixtures: 1, runsPerTask: 4, maxRuns: 60, labels, metric: 'tokens' });
    const cost = formatPlan(plan, { fixtures: 1, runsPerTask: 4, maxRuns: 60, labels });
    expect(tok.join('\n')).toContain(`planned MDE:      ${(100 * plan.mde).toFixed(1)}% saving in token use detectable at n = 4 per arm (CV 0.25 of token use per run; α 0.05`);
    expect(tok.join('\n')).toContain('saving in token use needed for a "measured saving" verdict');
    expect(cost.join('\n')).toContain(`planned MDE:      ${(100 * plan.mde).toFixed(1)}% saving detectable at n = 4 per arm (CV 0.25; α 0.05`);
    expect(formatPlan(plan, { fixtures: 1, runsPerTask: 4, maxRuns: 60, labels, metric: 'cost' })).toEqual(cost);
  });
});

describe('older records and --metric cost (differential, #1165)', () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'metric-cost-golden.json'), 'utf8')) as {
    cases: { input: { seed: number; resamples: number; status: 'complete' | 'incomplete'; stop: string | null; record: ComparisonRecordV1 }; output: { analysis: unknown; verdictText: string; report: string[] } }[];
  };

  it('a record without `metric` (schema 1.4.0) validates, reads as cost and reports in cost wording', () => {
    const old = validComparison();
    expect(old.metric).toBeUndefined();
    expect(validateRecord(old)).toEqual([]);
    expect(validateRecord({ ...old, schemaVersion: '1.4.0' })).toEqual([]);
    expect(recordMetric(old)).toBe('cost');
    const lines = formatReport(old, { billing: 'api' });
    expect(lines.join('\n')).toMatch(/cost ratio: +0\.540/);
    expect(formatReport({ ...old, metric: 'cost' }, { billing: 'api' })).toEqual(lines);
  });

  it(`--metric cost gives exactly the pre-change analysis, verdict and report on ${40} golden run sets (main@6148cfd8)`, () => {
    expect(golden.cases).toHaveLength(40);
    for (const { input, output } of golden.cases) {
      const { runs, exclusions } = input.record;
      const opts = { seed: input.seed, resamples: input.resamples, status: input.status, ...(input.stop ? { stop: input.stop as 'run-cap' } : {}) };
      expect(analyzeRuns(runs, exclusions, { ...opts, metric: 'cost' })).toEqual(output.analysis);
      expect(analyzeRuns(runs, exclusions, opts)).toEqual(output.analysis);
      expect(recordVerdictText(input.record)).toBe(output.verdictText);
      expect(recordVerdictText({ ...input.record, metric: 'cost' })).toBe(output.verdictText);
      expect(formatReport(input.record)).toEqual(output.report);
      expect(formatReport({ ...input.record, metric: 'cost', schemaVersion: '1.5.0' })).toEqual(output.report);
    }
  });

  it('the token metric counts the same runs as cost would when both are positive (taskValues)', () => {
    const { runs, exclusions } = golden.cases[1]!.input.record;
    const n = (m: 'tokens' | 'cost') => taskValues(runs, exclusions, m).reduce((s, t) => s + t.baseline.length + t.changed.length, 0);
    const positiveCost = runs.filter((r) => r.metrics.totalCostUsd > 0 && !exclusions.some((e) => e.seq === r.seq)).length;
    expect(n('cost')).toBe(positiveCost);
    expect(n('tokens')).toBeGreaterThanOrEqual(positiveCost);
  });
});
