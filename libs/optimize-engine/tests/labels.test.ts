// Cost labels and claim rules (R0-10, R0-11; feature doc cost-labels.md; legal note §2.2 qualifiers 1-7):
// unit tests per label, the claim checker on known-bad lines, the verdict/CI rounding fix (QA follow-up on
//), and property tests over generated comparison records in both auth modes and every billing mode. The
// property assertions are written here independently of `claimViolations`, so a bug in the checker cannot hide one.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analyzeRuns,
  BILLING_MODES,
  claimViolations,
  ClaimViolationError,
  COST_LABEL_NAMES,
  costLabels,
  costLabelText,
  formatPlan,
  formatReport,
  measurementLabel,
  MEASURING_QUALIFIER,
  MODEL_CHANGE_NOTE,
  recordLabels,
  withModelChange,
  planComparison,
  printedVerdictCode,
  readBilling,
  savingLabel,
  SCOPE_QUALIFIER,
  SUBSCRIPTION_QUALIFIER,
  validateRecord,
  verdictCode,
  writeBilling,
  type BillingMode,
  type ComparisonRecordV1,
} from '../src';
import { memoryFs, REPO, validComparison } from './samples';

const FORBIDDEN = /quality unchanged|verified[- ]quality|no quality loss|\bsafe\b|\bproves?\b|nothing leaves|you saved/i;
const MONEY = /(USD|EUR|\$|€)\s?\d/;
const LABEL_NAMES = Object.values(COST_LABEL_NAMES);

describe('labels: one per billing mode and auth mode', () => {
  it('measurement cost follows who pays for the runs', () => {
    for (const b of [null, ...BILLING_MODES]) expect(measurementLabel('api-key', b)).toBe('api-billing');
    expect(measurementLabel('subscription', 'subscription')).toBe('subscription-capacity');
    expect(measurementLabel('subscription', null)).toBe('subscription-capacity');
    expect(measurementLabel('subscription', 'credits')).toBe('usage-credits');
    expect(measurementLabel('subscription', 'api')).toBe('api-billing');
    expect(measurementLabel(undefined, null)).toBe('api-equivalent-estimate');
    expect(measurementLabel(undefined, 'subscription')).toBe('subscription-capacity');
  });

  it('a saving follows the billing mode; unset is an API-equivalent estimate', () => {
    expect(savingLabel('api')).toBe('api-billing');
    expect(savingLabel('subscription')).toBe('subscription-capacity');
    expect(savingLabel('credits')).toBe('usage-credits');
    expect(savingLabel(null)).toBe('api-equivalent-estimate');
  });

  it('every label text has exactly one label name and the client-side-estimate note', () => {
    for (const code of ['api-billing', 'api-equivalent-estimate', 'subscription-capacity', 'usage-credits'] as const) {
      const t = costLabelText(code);
      expect(LABEL_NAMES.filter((n) => t.includes(n))).toEqual([COST_LABEL_NAMES[code]]);
      expect(t).toContain("Claude Code's client-side estimate");
    }
    expect(costLabelText('subscription-capacity')).toContain('not money you pay');
  });

  it('billing mode is stored in the local store and read back; junk reads as unset', () => {
    const fs = memoryFs();
    expect(readBilling(fs, REPO)).toBeNull();
    writeBilling(fs, REPO, 'subscription');
    expect(readBilling(fs, REPO)).toBe('subscription');
    expect(fs.files.get(`${REPO}/.crafthall/optimize/.gitignore`)).toContain('*');
    fs.files.set(`${REPO}/.crafthall/optimize/config.json`, '{"billing":"free"}');
    expect(readBilling(fs, REPO)).toBeNull();
  });
});

describe('claim checker', () => {
  const sub = costLabels('subscription', 'subscription');
  const ok = [`Not enough evidence: cost ratio 0.950 (95% CI 0.800–1.000), measured on 8 runs of your fixtures.`, SUBSCRIPTION_QUALIFIER, MEASURING_QUALIFIER, SCOPE_QUALIFIER];
  it('passes a compliant report and flags each broken rule', () => {
    expect(claimViolations(ok, { labels: sub, report: true })).toEqual([]);
    const bad = (lines: string[]) => claimViolations(lines, { labels: sub, report: true });
    expect(bad([...ok, 'You saved USD 4.00 this month.']).join()).toMatch(/forbidden|saving/);
    expect(bad([...ok, 'quality unchanged'])).not.toEqual([]);
    expect(bad([...ok, 'a saving of $3 (subscription capacity – Claude Code\'s client-side estimate)'])).not.toEqual([]);
    expect(bad([...ok, 'cost: USD 3.00'])).not.toEqual([]);
    expect(bad(['Likely saving, not proven: cost ratio 0.900 (95% CI 0.800–1.000), measured on 8 runs of your fixtures.', ...ok.slice(1)]).join()).toMatch(/contains 1/);
    expect(bad(ok.slice(0, 3)).join()).toMatch(/qualifier 7/);
  });
  it('formatReport throws ClaimViolationError rather than print a non-compliant line (bug guard)', () => {
    const r = validComparison();
    r.versions = { ...r.versions, claudeCode: 'safe 2.0' };
    expect(() => formatReport(r, { billing: 'api' })).toThrow(ClaimViolationError);
  });
});

describe('verdict and printed interval agree (follow-up)', () => {
  it('an upper bound of 0.9996 prints as 1.000 with "not enough evidence"', () => {
    expect(verdictCode(0.88, [0.7, 0.9996])).toBe('likely-saving');
    expect(printedVerdictCode(0.88, [0.7, 0.9996])).toBe('not-enough-evidence');
    const r = { ...validComparison(), result: { ...validComparison().result, costRatio: 0.88, ci95: [0.7, 0.9996] as [number, number] } };
    const lines = formatReport(r, { billing: 'api' });
    expect(lines[0]).toMatch(/^Not enough evidence: cost ratio 0\.880 \(95% CI 0\.700–1\.000\)/);
  });

  it('property: whenever a printed CI contains 1.000 the verdict line says "Not enough evidence"', () => {
    const near = fc.oneof(fc.double({ min: 0.9990, max: 1.0010, noNaN: true }), fc.double({ min: 0.3, max: 1.5, noNaN: true }));
    fc.assert(
      fc.property(near, near, fc.double({ min: 0, max: 1, noNaN: true }), (a, b, t) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const ratio = lo + t * (hi - lo);
        const r = { ...validComparison(), result: { ...validComparison().result, costRatio: ratio, ci95: [lo, hi] as [number, number] } };
        const first = formatReport(r, { billing: 'subscription' })[0]!;
        const m = /95% CI (\d\.\d{3})–(\d\.\d{3})/.exec(first)!;
        if (Number(m[1]) <= 1 && Number(m[2]) >= 1) expect(first).toMatch(/^Not enough evidence/);
        if (/^Measured saving/.test(first)) expect(Number(m[2])).toBeLessThanOrEqual(0.85);
      }),
      { numRuns: 2000 },
    );
  });
});

// Generated comparison records: any ratio/CI (or none), any pass counts and run costs, either auth mode or none,
// stored labels or not, every billing mode or unset.
const auths = fc.constantFrom('api-key' as const, 'subscription' as const, undefined);
const billings = fc.constantFrom<BillingMode | null>(null, ...BILLING_MODES);
const recordArb = fc
  .record({
    auth: auths,
    billing: billings,
    storeLabels: fc.boolean(),
    ci: fc.option(fc.tuple(fc.double({ min: 0.05, max: 3, noNaN: true }), fc.double({ min: 0.05, max: 3, noNaN: true })), { nil: null }),
    t: fc.double({ min: 0, max: 1, noNaN: true }),
    costs: fc.array(fc.double({ min: 0, max: 50, noNaN: true }), { minLength: 1, maxLength: 12 }),
    passed: fc.nat({ max: 40 }),
    status: fc.constantFrom('complete' as const, 'incomplete' as const),
  })
  .map(({ auth, billing, storeLabels, ci, t, costs, passed, status }) => {
    const base = validComparison();
    const interval = ci ? ([Math.min(...ci), Math.max(...ci)] as [number, number]) : null;
    const ratio = interval ? interval[0] + t * (interval[1] - interval[0]) : t > 0.5 ? 0.9 : null;
    const runs = costs.map((c, seq) => ({ seq, fixture: 'f1', arm: (seq % 2 ? 'changed' : 'baseline') as 'baseline' | 'changed', oracleExitCode: 0, metrics: { ...base.runs[0]!.metrics, totalCostUsd: c } }));
    const record: ComparisonRecordV1 = {
      ...base,
      schemaVersion: '1.2.0',
      status,
      ...(auth ? { auth } : {}),
      ...(storeLabels ? { labels: costLabels(auth, billing) } : {}),
      runs,
      exclusions: [],
      result: { costRatio: ratio, ci95: interval, passes: { baseline: { passed, total: passed + 2 }, changed: { passed, total: passed + 2 } } },
    };
    return { record, billing };
  });

describe('claim rules hold for every generated record (property)', () => {
  it('no money saving without per-token billing, no forbidden claim, one label and the estimate note per cost figure, qualifiers 1-7', () => {
    fc.assert(
      fc.property(recordArb, ({ record, billing }) => {
        expect(validateRecord(record)).toEqual([]);
        const lines = formatReport(record, { billing });
        const text = lines.join('\n');
        const labels = record.labels ?? costLabels(record.auth, billing);
        expect(text).not.toMatch(FORBIDDEN);
        for (const line of lines) {
          if (!MONEY.test(line)) continue;
          if (labels.billing !== 'api') expect(line).not.toMatch(/\bsav(e|ed|es|ing|ings)\b/i);
          expect(LABEL_NAMES.filter((n) => line.includes(n))).toHaveLength(1);
          expect(line).toContain("Claude Code's client-side estimate");
        }
        if (labels.billing === 'subscription' || labels.billing === 'unset') expect(text).toContain(SUBSCRIPTION_QUALIFIER);
        if (record.auth === 'subscription' && (billing === 'subscription' || billing === null) && !record.labels) expect(text).toContain('subscription capacity');
        if (record.auth === 'api-key') expect(text).toMatch(/measurement cost: USD [\d.]+ .*\(API billing – /);
        expect(lines[0]).toMatch(/measured on \d+ runs of your fixtures/);
        expect(text).toContain(MEASURING_QUALIFIER);
        expect(text).toContain(SCOPE_QUALIFIER);
        const ci = /95% CI (\d+\.\d{3})–(\d+\.\d{3})/.exec(text);
        if (ci && Number(ci[1]) <= 1 && Number(ci[2]) >= 1) expect(lines[0]).toMatch(/^Not enough evidence/);
      }),
      { numRuns: 1500 },
    );
  }, 30_000); // Wall-clock budget only: ~2 s alone, over 5 s under optimize:verify load; the assertions are unchanged.

  it('the plan block labels its expected cost for every auth and billing mode', () => {
    fc.assert(
      fc.property(auths, billings, fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 200 }), (auth, billing, runsPerTask, maxRuns) => {
        const p = planComparison({ fixtures: [{ name: 'f1', maxBudgetUsd: 0.5 }], runsPerTask, cv: null, maxRuns, monthlyVolume: 1000 });
        const lines = formatPlan(p, { fixtures: 1, runsPerTask, maxRuns, labels: costLabels(auth, billing) });
        const costLine = lines.find((l) => l.includes('expected cost'))!;
        expect(LABEL_NAMES.filter((n) => costLine.includes(n))).toHaveLength(1);
        expect(costLine).toContain("Claude Code's client-side estimate");
        expect(lines.join('\n')).not.toMatch(FORBIDDEN);
        expect(lines).toContain(MEASURING_QUALIFIER);
      }),
    );
  });

  it('analysed runs: stored verdict text equals the re-derived verdict line', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double({ min: 0.01, max: 2, noNaN: true }), fc.double({ min: 0.01, max: 2, noNaN: true })), { minLength: 2, maxLength: 10 }), fc.nat(), (pairs, seed) => {
        const runs = pairs.flatMap(([b, c], i) => [
          { seq: 2 * i, fixture: 'f1', arm: 'baseline' as const, oracleExitCode: 0, metrics: { ...validComparison().runs[0]!.metrics, totalCostUsd: b } },
          { seq: 2 * i + 1, fixture: 'f1', arm: 'changed' as const, oracleExitCode: 0, metrics: { ...validComparison().runs[0]!.metrics, totalCostUsd: c } },
        ]);
        const a = analyzeRuns(runs, [], { seed, resamples: 200, status: 'complete' });
        const record = { ...validComparison(), runs, exclusions: [], ...a };
        expect(formatReport(record, { billing: 'api' })[0]).toBe(a.verdict.text);
      }),
      { numRuns: 100 },
    );
  });
});

// Legal review L6 (crafthall-optimize-legal.md §8.8): different models per arm on subscription or credits billing claim
// no plan-capacity saving – the saving is an API-equivalent estimate and the report prints MODEL_CHANGE_NOTE.
describe('model change on plan or credits billing (L6)', () => {
  const SAME = { baseline: 'claude-opus-5-5', changed: 'claude-opus-5-5' };
  const DIFF = { baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' };
  const reportOf = (billing: BillingMode, models: { baseline?: string; changed?: string } | undefined, metric?: 'tokens' | 'cost') => {
    const base = validComparison();
    const record: ComparisonRecordV1 = {
      ...base,
      schemaVersion: '1.5.0',
      auth: 'subscription',
      labels: costLabels('subscription', billing, models),
      ...(metric ? { metric } : {}),
      versions: { ...base.versions, ...(models ? { modelByArm: models } : {}) },
    };
    return { record, text: formatReport(record).join('\n') };
  };

  it('same model on subscription keeps subscription capacity and prints no model-change note', () => {
    expect(savingLabel('subscription', false)).toBe('subscription-capacity');
    expect(costLabels('subscription', 'subscription', SAME).saving).toBe('subscription-capacity');
    const { text } = reportOf('subscription', SAME);
    expect(text).toContain(`saving counts as: subscription capacity: ${SUBSCRIPTION_QUALIFIER}`);
    expect(text).not.toContain(MODEL_CHANGE_NOTE);
  });

  it('different models on subscription → API-equivalent estimate plus the sentence (qualifier 3 still printed)', () => {
    expect(savingLabel('subscription', true)).toBe('api-equivalent-estimate');
    const labels = costLabels('subscription', 'subscription', DIFF);
    expect(labels).toEqual({ billing: 'subscription', measurementCost: 'subscription-capacity', saving: 'api-equivalent-estimate' });
    const { text } = reportOf('subscription', DIFF);
    expect(text).toContain(`saving counts as: API-equivalent estimate: ${MODEL_CHANGE_NOTE}`);
    expect(text).toContain(SUBSCRIPTION_QUALIFIER);
    expect(MODEL_CHANGE_NOTE).toBe('Anthropic does not publish how plan limits weight models, so no plan-capacity saving is claimed.');
  });

  it('different models on credits → API-equivalent estimate plus the sentence; same model keeps usage credits', () => {
    expect(costLabels('subscription', 'credits', DIFF).saving).toBe('api-equivalent-estimate');
    expect(costLabels('subscription', 'credits', SAME).saving).toBe('usage-credits');
    expect(reportOf('credits', DIFF).text).toContain(MODEL_CHANGE_NOTE);
    expect(reportOf('credits', SAME).text).not.toContain(MODEL_CHANGE_NOTE);
  });

  it('API billing is unchanged by a model change (per-token prices are published per model)', () => {
    expect(savingLabel('api', true)).toBe('api-billing');
    expect(costLabels('api-key', 'api', DIFF).saving).toBe('api-billing');
    expect(reportOf('api', DIFF).text).not.toContain(MODEL_CHANGE_NOTE);
  });

  it('the token metric carries the rule too (plan limits do not weight tokens of different models equally either)', () => {
    const { text } = reportOf('subscription', DIFF, 'tokens');
    expect(text).toContain('token ratio:');
    expect(text).toContain(MODEL_CHANGE_NOTE);
  });

  it('a record stored before the rule (labels subscription-capacity, different models) is reported with the rule applied', () => {
    const base = validComparison();
    const record: ComparisonRecordV1 = { ...base, schemaVersion: '1.3.0', labels: costLabels('subscription', 'subscription'), versions: { ...base.versions, modelByArm: DIFF } };
    expect(record.labels!.saving).toBe('subscription-capacity');
    expect(recordLabels(record, null).saving).toBe('api-equivalent-estimate');
    expect(formatReport(record).join('\n')).toContain(MODEL_CHANGE_NOTE);
    expect(withModelChange(record.labels!, SAME)).toBe(record.labels);
  });

  it('the claim checker flags a plan-billing model-change report without the sentence', () => {
    const { record } = reportOf('subscription', DIFF);
    const lines = formatReport(record).filter((l) => !l.includes(MODEL_CHANGE_NOTE));
    expect(claimViolations(lines, { labels: record.labels!, report: true })).toContain('missing the model-change note (L6: no plan-capacity saving across models)');
  });

  // Property + differential: over generated billing modes, auths, arm models (equal, different, missing) and stored or
  // derived labels, the saving label equals an independent oracle written from the rule's wording, the verdict
  // statistics do not depend on the models, and the sentence is printed exactly when the rule applies.
  it('property: saving label and sentence follow the rule for every billing / auth / model combination; verdict unchanged', () => {
    const model = fc.option(fc.constantFrom('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'), { nil: undefined });
    fc.assert(
      fc.property(auths, billings, model, model, fc.boolean(), fc.constantFrom('tokens' as const, 'cost' as const), (auth, billing, mb, mc, stored, metric) => {
        const base = validComparison();
        const modelByArm = { ...(mb ? { baseline: mb } : {}), ...(mc ? { changed: mc } : {}) };
        const record: ComparisonRecordV1 = {
          ...base,
          schemaVersion: '1.5.0',
          metric,
          ...(auth ? { auth } : {}),
          ...(stored ? { labels: costLabels(auth, billing) } : {}),
          versions: { ...base.versions, modelByArm },
        };
        const differ = mb !== undefined && mc !== undefined && mb !== mc;
        const expected = billing === 'api' ? 'api-billing' : billing === null ? 'api-equivalent-estimate' : differ ? 'api-equivalent-estimate' : billing === 'subscription' ? 'subscription-capacity' : 'usage-credits';
        const labels = recordLabels(record, billing);
        expect(labels.saving).toBe(expected);
        expect(labels.measurementCost).toBe(measurementLabel(auth, billing));
        const lines = formatReport(record, { billing });
        expect(lines.join('\n').includes(MODEL_CHANGE_NOTE)).toBe(differ && (billing === 'subscription' || billing === 'credits'));
        // Differential: the same record without models prints the same verdict line (no change to verdict statistics).
        const noModels: ComparisonRecordV1 = { ...record, versions: { ...base.versions } };
        expect(lines[0]).toBe(formatReport(noModels, { billing })[0]);
      }),
      { numRuns: 500 },
    );
  });
});
