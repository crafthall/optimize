// Paired before/after comparison (R0-06…R0-08; validation §4): the `claude -p` JSON reader, the plan block
// (planned MDE, expected cost, payback), the interleaved run schedule, the analysis of the runs into result and
// verdict, and the report text. Pure: the CLI does the processes, files and clock.
import { costLabels, costLabelText, enforceClaims, MEASURING_QUALIFIER, SCOPE_QUALIFIER, savingMeaning, withModelChange, type CostLabels } from './labels';
import type { BillingMode } from './labels';
import type { Arm, ComparisonRecordV1, Metric, ModelUsageTokens, RunMetricsV1, StopReason } from './records';
import {
  ratioCi,
  DEFAULT_CV,
  geometricCostRatio,
  PAYBACK_LIMIT_MONTHS,
  paybackMonths,
  qualityBound,
  VERDICT_THRESHOLDS,
  verdictCode,
  zSum,
  logSigma,
  planDegreesOfFreedom,
  minimumDetectableEffectT,
  measuredSavingMdeT,
  type TaskCosts,
  type VerdictCode,
} from './stats';

// ---------------------------------------------------------------------------------------------------------------
// `claude -p --output-format json` reader. Documented result fields only: `subtype`, `is_error`, `total_cost_usd`,
// `duration_api_ms`, `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
// cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}}` and `modelUsage` (keyed by model id). The
// `result` text (the model's answer) is never read.

export interface ClaudeRunResult {
  metrics: RunMetricsV1;
  /** `subtype` of the result, e.g. `success`, `error_max_budget_usd`, `error_max_turns`. */
  subtype: string;
  isError: boolean;
}

const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const int = (v: unknown): number => Math.round(nonNeg(v));
const MODEL_ID = /^[0-9A-Za-z.:@_-]{1,128}$/;

/**
 * Resolved model of a run: the `modelUsage` key with the highest cost (a session may use a small model for
 * background work). Null when `modelUsage` is missing or holds no valid model id.
 */
export function resolvedModel(modelUsage: unknown): string | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let best: { id: string; cost: number; tokens: number } | null = null;
  for (const [id, u] of Object.entries(modelUsage as Record<string, Record<string, unknown>>)) {
    if (!MODEL_ID.test(id)) continue;
    const cost = nonNeg(u?.costUSD);
    const tokens = nonNeg(u?.outputTokens) + nonNeg(u?.inputTokens);
    if (!best || cost > best.cost || (cost === best.cost && tokens > best.tokens)) best = { id, cost, tokens };
  }
  return best?.id ?? null;
}

/**
 * Tokens of a run summed over every model of `modelUsage`: input, cache write (`cacheCreationInputTokens`,
 * which is the 5m + 1h sum), cache read and output. Entries that are no object count 0.
 */
export function modelUsageTokens(modelUsage: unknown): ModelUsageTokens {
  const out = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  if (!modelUsage || typeof modelUsage !== 'object') return out;
  for (const u of Object.values(modelUsage as Record<string, unknown>)) {
    if (!u || typeof u !== 'object') continue;
    const m = u as Record<string, unknown>;
    out.input += int(m.inputTokens);
    out.cacheWrite += int(m.cacheCreationInputTokens);
    out.cacheRead += int(m.cacheReadInputTokens);
    out.output += int(m.outputTokens);
  }
  return out;
}

/** Parses the stdout of `claude -p --output-format json`; null when it is no result object with a cost and a model. */
export function parseClaudeJson(stdout: string): ClaudeRunResult | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (Array.isArray(value)) value = [...value].reverse().find((m: { type?: string }) => m?.type === 'result');
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.total_cost_usd !== 'number' || !Number.isFinite(r.total_cost_usd)) return null;
  const model = resolvedModel(r.modelUsage);
  if (!model) return null;
  const usage = (r.usage ?? {}) as Record<string, unknown>;
  const split = (usage.cache_creation ?? {}) as Record<string, unknown>;
  const hasSplit = 'ephemeral_5m_input_tokens' in split || 'ephemeral_1h_input_tokens' in split;
  return {
    subtype: typeof r.subtype === 'string' ? r.subtype : 'unknown',
    isError: r.is_error === true,
    metrics: {
      inputTokens: int(usage.input_tokens),
      cacheCreation5mTokens: hasSplit ? int(split.ephemeral_5m_input_tokens) : int(usage.cache_creation_input_tokens),
      cacheCreation1hTokens: hasSplit ? int(split.ephemeral_1h_input_tokens) : 0,
      cacheReadTokens: int(usage.cache_read_input_tokens),
      outputTokens: int(usage.output_tokens),
      totalCostUsd: Math.min(100000, nonNeg(r.total_cost_usd)),
      durationApiMs: int(r.duration_api_ms),
      model,
      modelUsageTokens: modelUsageTokens(r.modelUsage),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Metric of the verdict: token use or API-equivalent cost.

/**
 * Default metric for a billing mode: `tokens` for subscription and credits billing (their limit is not billed
 * in dollars; token use is a raw count at weight 1 per token kind, not a model of how the limit is charged – QA
 * review), `cost` for API billing and for an unset mode (the unset label is the API-equivalent estimate, and
 * records without a metric read as cost).
 */
export const defaultMetric = (billing: BillingMode | 'unset' | null | undefined): Metric => (billing === 'subscription' || billing === 'credits' ? 'tokens' : 'cost');

/** The metric of a record: its stored `metric`, else `cost` (records before schema 1.5.0). */
export const recordMetric = (record: Pick<ComparisonRecordV1, 'metric'>): Metric => record.metric ?? 'cost';

/**
 * Token components of a run: `modelUsageTokens` (summed over models, schema 1.5.0) when present and above 0, else the
 * top-level `usage` fields (input, cache write 5m + 1h, cache read, output) of older records.
 */
export function runTokenComponents(m: RunMetricsV1): ModelUsageTokens {
  // A per-model sum of 0 (a `modelUsage` without token fields) falls back to `usage` too, so the run is counted (Lead).
  const u = m.modelUsageTokens;
  if (u && u.input + u.cacheWrite + u.cacheRead + u.output > 0) return u;
  return { input: m.inputTokens, cacheWrite: m.cacheCreation5mTokens + m.cacheCreation1hTokens, cacheRead: m.cacheReadTokens, output: m.outputTokens };
}

/** Token use of a run: input + cache write + cache read + output tokens. */
export function runTokens(m: RunMetricsV1): number {
  const c = runTokenComponents(m);
  return c.input + c.cacheWrite + c.cacheRead + c.output;
}

/** The value of a run under a metric: `total_cost_usd` for cost, token use for tokens. */
export const runValue = (m: RunMetricsV1, metric: Metric): number => (metric === 'tokens' ? runTokens(m) : m.totalCostUsd);

/** Token components in report order with their printed names. */
export const TOKEN_COMPONENTS: readonly { key: keyof ModelUsageTokens; name: string }[] = [
  { key: 'input', name: 'input' },
  { key: 'cacheWrite', name: 'cache write' },
  { key: 'cacheRead', name: 'cache read' },
  { key: 'output', name: 'output' },
];

// ---------------------------------------------------------------------------------------------------------------
// Model pin per (arm, configured model) (and its QA review). Fixtures of one arm that configure the
// same model in `.claude/settings.json` – or none, so they all inherit the same user or environment model – share one
// pin; only a fixture configured differently gets its own. A later run of a pin group on another model is excluded as
// `model-fallback`. A model that differs between the arms is the change under test, and a model that differs between
// differently configured fixtures is their own configuration, so neither excludes a run of another group.

/** Resolved model per arm: the model of each arm's first counted run (record field `versions.modelByArm`, schema 1.3.0). */
export type ModelByArm = Partial<Record<Arm, string>>;

/** Key of one model pin: an arm plus a group label. */
export const modelPinKey = (arm: Arm, group: string): string => `${arm}/${group}`;

/**
 * The pin key of a run (QA review): its arm plus its fixture's configured model for that arm (null = not
 * set). Equal configurations, including none, give one key; per-fixture keys would let a fallback on a later fixture's
 * first run pin that fixture and pass unexcluded.
 */
export const modelPinKeyFor = (arm: Arm, configured: string | null | undefined): string => modelPinKey(arm, JSON.stringify(configured ?? null));

/**
 * Exclusion rule for the model of one counted run (a run not excluded for another reason). The first counted run of
 * a pin key (`modelPinKeyFor(arm, configured model)` – before it, the arm) pins that key's model in `pins` (mutated) and is
 * never a fallback; a later run of the key is a fallback exactly when its model differs from the pin. Runs of other
 * keys are never consulted.
 */
export function isModelFallback<K extends string>(pins: Partial<Record<K, string>>, key: K, model: string, planned?: ((model: string) => boolean) | null): boolean {
  const pinned = pins[key];
  if (pinned === undefined) {
    // QA ruling 1 (stats review §11): with a known planned model, a first run off the plan is a fallback
    // and does not pin the key; otherwise one early fallback would pin the fallback model and exclude every on-plan run.
    if (planned && !planned(model)) return true;
    pins[key] = model;
    return false;
  }
  return model !== pinned;
}

/**
 * Matcher for the planned model of one pin group (the `model` of `.claude/settings.json` at the fixture commit, with the
 * patch for the changed arm – before it, one value for every fixture of the arm):
 * a family alias (`opus`, `sonnet`, `haiku`, optionally `[1m]`) matches a reported id of that family; a full
 * `claude-…` id matches itself or a dated variant. Anything else (`opusplan`, `default`, a provider ARN, no setting) →
 * null: the key keeps the first-counted-run pin. A wrong match can only exclude runs (never add one), so the failure
 * mode is "not enough evidence", never a false saving.
 */
export function plannedModelMatcher(configured: string | null): ((model: string) => boolean) | null {
  if (!configured) return null;
  const alias = /^(opus|sonnet|haiku)(\[1m\])?$/.exec(configured);
  if (alias) return (m) => m.split(/[-.@:/]/).includes(alias[1]!);
  if (/^claude-[0-9a-z.-]+$/.test(configured)) return (m) => m === configured || m.startsWith(`${configured}-`);
  return null;
}

/** "baseline A, changed B" (or one model for both arms); arms without a model are omitted, none → null. */
export function modelByArmText(models: ModelByArm | undefined): string | null {
  const b = models?.baseline;
  const c = models?.changed;
  if (b && c) return b === c ? `${b} (both arms)` : `baseline ${b}, changed ${c}`;
  if (b) return `baseline ${b}`;
  if (c) return `changed ${c}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan (validation §4.4, §4.5; r0 §4 spending guard).

export interface PlanInput {
  fixtures: readonly { name: string; maxBudgetUsd: number }[];
  /** Runs per arm per task (r0 §4 `--runs-per-arm`, default 4). */
  runsPerTask: number;
  /** CV of the per-task cost (token use under the tokens metric); `null` → DEFAULT_CV, labelled as an assumption. */
  cv: number | null;
  /** Total run cap of the comparison (`--max-runs`, default 60). */
  maxRuns: number;
  /** The user's monthly volume in USD (`--monthly-volume`); null when not given. */
  monthlyVolume: number | null;
}

export interface Plan {
  /**
   * n per arm the MDE uses: runs per task × tasks, or, when the run cap stops the plan earlier, the runs per arm that
   * fit under the cap (the smaller arm of the interleaved schedule; stats review follow-up 4).
   */
  nPerArm: number;
  /** n per arm of the full plan (runs per task × tasks), before the cap. */
  fullNPerArm: number;
  totalRuns: number;
  cv: number;
  cvAssumed: boolean;
  /** Planned minimum detectable saving for nPerArm (fraction): the saving at which the 95% CI excludes 1.0, 80% power. */
  mde: number;
  /**
   * The saving needed for a "measured saving" verdict (CI upper bound ≤ 0.85) at 80% power for nPerArm (fraction;
   * stats review follow-up 2): about 39.2% at n = 12, CV 0.30, where `mde` is 28.5%.
   */
  mdeMeasured: number;
  /**
   * Expected measurement cost in USD. Before any pilot the median baseline run cost is unknown, so this is the upper
   * bound: every planned run (up to the run cap) at its per-run budget cap.
   */
  expectedCostUsd: number;
  expectedCostIsUpperBound: true;
  /** Break-even horizon in months, using the planned MDE as the estimated saving; null without a monthly volume. */
  paybackMonths: number | null;
  /** True when the run cap stops the plan before it completes. */
  capped: boolean;
  /**
   * False when some task gets fewer than 2 runs in an arm under the plan (runs per arm 1, or a run cap below 4 runs per
   * task): the Welch floor then has no variance estimate, `ratioCi` is null and the verdict can only be "not enough
   * evidence" (review). Both MDEs are then 1 and the plan is refused without --force.
   */
  intervalPossible: boolean;
  /** Why the spending guard refuses without `--force`, or null. */
  refusal: string | null;
}

export const COMPARE_DEFAULTS = { runsPerTask: 4, maxRuns: 60, maxBudgetUsd: 0.5 } as const;

/** The interleaved run order (validation §4.1): per round, per task, baseline then changed (A/B/A/B per task). */
export function runSchedule(fixtures: readonly string[], runsPerTask: number): { fixture: string; arm: Arm }[] {
  const out: { fixture: string; arm: Arm }[] = [];
  for (let i = 0; i < runsPerTask; i++) for (const fixture of fixtures) out.push({ fixture, arm: 'baseline' }, { fixture, arm: 'changed' });
  return out;
}

/**
 * The saving a "measured saving" verdict needs at 80% power: the CI upper bound must reach 0.85, not just 1.0, so the
 * true ratio must sit z·σ·√(2/n) below 0.85 on the log scale – MDE_measured = 1 − 0.85 · exp(−(z_{0.975} + z_{0.80}) ·
 * σ · √(2/n)) (stats review §2 and follow-up 2). Same normal-quantile approximation as the planned MDE. n = 0 → 1.
 */
export function measuredSavingMde(cv: number, nPerArm: number): number {
  if (nPerArm < 1) return 1;
  return 1 - VERDICT_THRESHOLDS.provenUpper * Math.exp(-zSum() * logSigma(cv) * Math.sqrt(2 / nPerArm));
}

/** The printed planned MDE (t-based, Lead decision on the review): 1 (nothing detectable) when df ≤ 0. */
const plannedMde = (cv: number, nPerArm: number, tasks: number): number => {
  const df = planDegreesOfFreedom(nPerArm, tasks);
  return nPerArm < 1 || df <= 0 ? 1 : minimumDetectableEffectT(cv, nPerArm, df);
};

export function planComparison(input: PlanInput): Plan {
  const cvAssumed = input.cv === null;
  const cv = input.cv ?? DEFAULT_CV;
  const fullNPerArm = input.runsPerTask * input.fixtures.length;
  const schedule = runSchedule(input.fixtures.map((f) => f.name), input.runsPerTask);
  const budget = new Map(input.fixtures.map((f) => [f.name, f.maxBudgetUsd]));
  const planned = schedule.slice(0, input.maxRuns);
  const expectedCostUsd = Math.round(planned.reduce((s, r) => s + budget.get(r.fixture)!, 0) * 100) / 100;
  // Under the cap, the analysis sees only the runs that fit: n is the smaller arm of the truncated schedule.
  const nPerArm = Math.min(...(['baseline', 'changed'] as const).map((arm) => planned.filter((r) => r.arm === arm).length));
  // ratioCi needs at least 2 runs in each arm of every task that has both arms (welchRatioCi); under the interleaved
  // schedule that means every task needs 2 runs per arm, i.e. runs per arm ≥ 2 and a cap of at least 4 runs per task.
  const perCell = (fixture: string, arm: Arm) => planned.filter((r) => r.fixture === fixture && r.arm === arm).length;
  const intervalPossible = input.fixtures.length > 0 && input.fixtures.every((f) => perCell(f.name, 'baseline') >= 2 && perCell(f.name, 'changed') >= 2);
  // Both printed numbers use t quantiles with df = 2·K·(m − 1) for the runs that fit (Lead decision review §9).
  const K = input.fixtures.length;
  const mde = intervalPossible ? plannedMde(cv, nPerArm, K) : 1;
  const mdeMeasured = intervalPossible ? measuredSavingMdeT(cv, nPerArm, planDegreesOfFreedom(nPerArm, K)) : 1;
  const payback = intervalPossible ? paybackMonths(expectedCostUsd, mde, input.monthlyVolume) : null;
  const refusal = !intervalPossible
    ? `no interval and no verdict are possible: every task needs at least 2 runs per arm (--runs-per-arm ≥ 2 and --max-runs ≥ ${4 * input.fixtures.length}); the result could only be "not enough evidence". Raise them, or --force`
    : payback === null
      ? 'the payback horizon is unknown: pass --monthly-volume <usd> (your monthly Claude spend) or --force'
      : payback > PAYBACK_LIMIT_MONTHS
        ? `the measurement would take ${payback.toFixed(1)} months to pay back (limit ${PAYBACK_LIMIT_MONTHS}); use fewer runs, a larger change, or --force`
        : null;
  return { nPerArm, fullNPerArm, totalRuns: schedule.length, cv, cvAssumed, mde, mdeMeasured, expectedCostUsd, expectedCostIsUpperBound: true, paybackMonths: payback, capped: schedule.length > input.maxRuns, intervalPossible, refusal };
}

const pct = (x: number, digits = 1): string => `${(100 * x).toFixed(digits)}%`;
const usd = (x: number): string => `USD ${x.toFixed(2)}`;

/** The plan block printed before anything runs (r0 §4); cost figures carry `labels.measurementCost`. */
export function formatPlan(
  plan: Plan,
  opts: {
    fixtures: number;
    runsPerTask: number;
    maxRuns: number;
    labels: CostLabels;
    /** Model each arm is configured with (`.claude/settings.json` `model` at the fixture commit); null = not set there. */
    configuredModels?: Record<Arm, string | null>;
    /** Metric of the verdict; absent = cost (the wording before unchanged). */
    metric?: Metric;
  },
): string[] {
  const label = costLabelText(opts.labels.measurementCost);
  const tokens = opts.metric === 'tokens';
  const saving = tokens ? 'saving in token use' : 'saving';
  const noInterval = `  planned MDE:      none – some task gets fewer than 2 runs per arm, so no confidence interval and no verdict but "not enough evidence" are possible`;
  const lines = [
    `Plan: ${plan.totalRuns} runs (${opts.runsPerTask} per arm per task × ${opts.fixtures} task${opts.fixtures === 1 ? '' : 's'} × 2 arms), interleaved, every run cold`,
    ...(plan.intervalPossible
      ? [
          `  planned MDE:      ${pct(plan.mde)} ${saving} detectable at n = ${plan.nPerArm} per arm (CV ${plan.cv.toFixed(2)}${tokens ? ' of token use per run' : ''}${plan.cvAssumed ? ', assumed – no pilot' : ''}; α 0.05; t-based, ≈ 80% power): the 95% CI excludes 1.0`,
          `  measured saving:  ${pct(plan.mdeMeasured)} ${saving} needed for a "measured saving" verdict (CI upper bound ≤ ${VERDICT_THRESHOLDS.provenUpper.toFixed(2)}) at the same n (t-based, ≈ 80% power)`,
        ]
      : [noInterval]),
    ...(plan.capped && plan.intervalPossible
      ? [`  capped n:         both figures use the ${plan.nPerArm} runs per arm that fit under the run cap; the full plan (n = ${plan.fullNPerArm} per arm) would detect ${pct(plannedMde(plan.cv, plan.fullNPerArm, opts.fixtures))}`]
      : []),
    `  expected cost:    at most ${usd(plan.expectedCostUsd)}, every run at its --max-budget-usd cap (${label})`,
    `  payback horizon:  ${plan.paybackMonths === null ? 'unknown (no --monthly-volume)' : `${plan.paybackMonths.toFixed(2)} months at a ${pct(plan.mde)} ${saving}${tokens ? ' (assumes your monthly volume falls by the same share)' : ''}`}`,
    `  run cap:          ${opts.maxRuns}${plan.capped ? ` – the plan needs ${plan.totalRuns}; the comparison stops at the cap and is marked incomplete` : ''}`,
    ...(tokens ? [TOKEN_METRIC_LINE] : []),
    ...(opts.configuredModels
      ? [
          `  model per arm:    baseline ${opts.configuredModels.baseline ?? 'your Claude Code default'}, changed ${opts.configuredModels.changed ?? 'your Claude Code default'} (.claude/settings.json \`model\` at the fixture commit; each arm pins the model of its first counted run, and a later run of that arm on another model is excluded)`,
        ]
      : []),
    MEASURING_QUALIFIER,
  ];
  return enforceClaims(lines, { labels: opts.labels, report: false, metric: opts.metric ?? 'cost' });
}

/** What the tokens metric counts (plan block and report); no currency. */
export const TOKEN_METRIC_LINE =
  "  metric:           token use – raw count of input, cache write (5m + 1h), cache read and output tokens, summed over every model of the run; cache reads count at full weight (how your plan's limit weighs token kinds is not published; a model switch can change cost without changing token use)";

// ---------------------------------------------------------------------------------------------------------------
// Analysis and verdict.

type Run = ComparisonRecordV1['runs'][number];
type Exclusion = ComparisonRecordV1['exclusions'][number];

/**
 * Values per task and arm of the runs that count under a metric: not excluded, positive value (cost, or token
 * use). The statistics (`geometricCostRatio`, `ratioCi`) are the same for both metrics.
 */
export function taskValues(runs: readonly Run[], exclusions: readonly Exclusion[], metric: Metric): TaskCosts[] {
  const excluded = new Set(exclusions.map((e) => e.seq));
  const byTask = new Map<string, TaskCosts & { baseline: number[]; changed: number[] }>();
  for (const r of runs) {
    const v = runValue(r.metrics, metric);
    if (excluded.has(r.seq) || !(v > 0)) continue;
    const t = byTask.get(r.fixture) ?? { task: r.fixture, baseline: [], changed: [] };
    t[r.arm].push(v);
    byTask.set(r.fixture, t);
  }
  return [...byTask.values()];
}

/** Costs per task and arm of the runs that count: not excluded, positive cost. */
export const taskCosts = (runs: readonly Run[], exclusions: readonly Exclusion[]): TaskCosts[] => taskValues(runs, exclusions, 'cost');

/**
 * Descriptive ratio changed ÷ baseline of each token component over the runs the tokens metric counts: per
 * task, mean changed component ÷ mean baseline component; then the geometric mean over the tasks where both means are
 * positive (null when there is none). No interval and no verdict: these lines only say where a change in token use
 * comes from.
 */
export function componentRatios(runs: readonly Run[], exclusions: readonly Exclusion[]): Record<keyof ModelUsageTokens, number | null> {
  const excluded = new Set(exclusions.map((e) => e.seq));
  const byTask = new Map<string, Record<Arm, ModelUsageTokens[]>>();
  for (const r of runs) {
    if (excluded.has(r.seq) || !(runTokens(r.metrics) > 0)) continue;
    const t = byTask.get(r.fixture) ?? { baseline: [], changed: [] };
    t[r.arm].push(runTokenComponents(r.metrics));
    byTask.set(r.fixture, t);
  }
  const out = { input: null, cacheWrite: null, cacheRead: null, output: null } as Record<keyof ModelUsageTokens, number | null>;
  for (const { key } of TOKEN_COMPONENTS) {
    const logs: number[] = [];
    for (const t of byTask.values()) {
      if (!t.baseline.length || !t.changed.length) continue;
      const a = t.baseline.reduce((s, c) => s + c[key], 0) / t.baseline.length;
      const b = t.changed.reduce((s, c) => s + c[key], 0) / t.changed.length;
      if (a > 0 && b > 0) logs.push(Math.log(b / a));
    }
    out[key] = logs.length ? Math.exp(logs.reduce((s, x) => s + x, 0) / logs.length) : null;
  }
  return out;
}

/** Pass counts per arm over the runs that count (oracle exit code 0 = pass; a run stopped by its budget cap fails). */
export function passCounts(runs: readonly Run[], exclusions: readonly Exclusion[]): Record<Arm, { passed: number; total: number }> {
  const excluded = new Set(exclusions.map((e) => e.seq));
  const out = { baseline: { passed: 0, total: 0 }, changed: { passed: 0, total: 0 } };
  for (const r of runs) {
    if (excluded.has(r.seq)) continue;
    out[r.arm].total++;
    if (r.oracleExitCode === 0) out[r.arm].passed++;
  }
  return out;
}

/** Seed of the bootstrap from the diff hash, so a record re-analyses to the same interval. */
export const seedFromHash = (hash: string): number => parseInt(hash.slice(hash.indexOf(':') + 1, hash.indexOf(':') + 9), 16) >>> 0;

/**
 * Decimals of every printed ratio and interval bound. The verdict is derived from the values rounded to this
 * precision (`printedVerdictCode`), so a printed interval and its verdict can never disagree: an upper bound of
 * 0.9996 prints as 1.000 and the verdict is "not enough evidence" (QA follow-up on). The rule
 * itself (`verdictCode`, stats.ts) is unchanged.
 */
export const PRINT_DECIMALS = 3;
const round = (x: number): number => Number(x.toFixed(PRINT_DECIMALS));
export const printedCi = (ci: readonly [number, number] | null): [number, number] | null => (ci === null ? null : [round(ci[0]), round(ci[1])]);
const STRENGTH: Record<VerdictCode, number> = { 'not-enough-evidence': 0, 'likely-saving': 1, 'measured-saving': 2 };
/**
 * The verdict shown next to the printed interval: the more conservative of the verdict on the unrounded values
 * and the verdict on the printed (rounded) values. Rounding can only weaken a claim, never strengthen it
 * (e.g. an upper bound of 0.8504 prints as 0.850 but stays "likely", not "measured"; Lead).
 */
export const printedVerdictCode = (ratio: number | null, ci: readonly [number, number] | null): VerdictCode => {
  const raw = verdictCode(ratio, ci);
  const shown = verdictCode(ratio === null ? null : round(ratio), printedCi(ci));
  return STRENGTH[shown] < STRENGTH[raw] ? shown : raw;
};

const fmt = (x: number): string => x.toFixed(PRINT_DECIMALS);
const metricWord = (metric: Metric | undefined): string => (metric === 'tokens' ? 'token' : 'cost');
const ratioText = (ratio: number, ci: readonly [number, number], metric?: Metric): string => `${metricWord(metric)} ratio ${fmt(ratio)} (95% CI ${fmt(ci[0])}–${fmt(ci[1])})`;

/**
 * Verdict cap of a record the user interrupted (stats review §11 item 2): a Ctrl-C or kill may depend on the
 * results (a user stops a long, likely expensive run), so the stop is informative and the dropped run biases that arm's
 * cost down. Such a record is never a "measured saving": its verdict is at most "likely saving". A stop that does not
 * depend on the outcomes (run cap, Claude Code version change, an error) keeps the verdict.
 */
export function capVerdictForStop(code: VerdictCode, stop: StopReason | undefined): VerdictCode {
  return stop === 'interrupted' && code === 'measured-saving' ? 'likely-saving' : code;
}

/** Verdict text, first line of every report (legal note §2.2 items 1 and 4). */
export function verdictText(
  code: VerdictCode,
  ratio: number | null,
  ci: readonly [number, number] | null,
  pairedRuns: number,
  status: 'complete' | 'incomplete',
  stop?: StopReason,
  /**: `tokens` words the line in token use (no currency); absent or `cost` = the wording before. */
  metric?: Metric,
): string {
  const tokens = metric === 'tokens';
  const measured = `measured on ${pairedRuns} runs of your fixtures${status === 'incomplete' ? (stop === 'interrupted' ? ', incomplete – interrupted' : ', incomplete') : ''}`;
  if (ratio === null) return `Not enough evidence: no task has a counted run in both arms (${measured}).`;
  if (ci === null) return `Not enough evidence: at least 2 counted runs per arm in every task are needed for an interval; ${metricWord(metric)} ratio ${fmt(ratio)} (${measured}).`;
  const shown = printedCi(ci)!;
  const body = `${ratioText(ratio, ci, metric)}, ${measured}`;
  const inTokens = tokens ? ' in token use' : '';
  if (code === 'measured-saving') return `Measured saving of ${pct(1 - ratio, 0)}${inTokens}: ${body}.`;
  if (code === 'likely-saving') return `Likely saving${inTokens}, not proven: ${body}.`;
  if (shown[0] > 1) return `Not enough evidence of a saving – the change measured ${tokens ? 'more token use' : 'more expensive'}: ${body}.`;
  if (shown[1] < 1) return `Not enough evidence of a saving${inTokens} of 10% or more: ${body}.`;
  return `Not enough evidence: ${body}.`;
}

const countedRuns = (tasks: readonly TaskCosts[]): number => tasks.reduce((s, t) => s + t.baseline.length + t.changed.length, 0);

/** The verdict line of a stored record, re-derived from its result (so a re-printed report follows today's rules). */
export function recordVerdictText(record: Pick<ComparisonRecordV1, 'result' | 'runs' | 'exclusions' | 'status' | 'stop' | 'metric'>): string {
  const { costRatio, ci95 } = record.result;
  // An incomplete record written before schema 1.4.0 has no `stop`: it may have been interrupted, so it is capped too
  // (QA review, Lead decision – conservative).
  const code = capVerdictForStop(printedVerdictCode(costRatio, ci95), record.stop ?? (record.status === 'incomplete' ? 'interrupted' : undefined));
  const metric = recordMetric(record);
  return verdictText(code, costRatio, ci95, countedRuns(taskValues(record.runs, record.exclusions, metric)), record.status, record.stop, record.metric);
}

export interface Analysis {
  result: ComparisonRecordV1['result'];
  verdict: ComparisonRecordV1['verdict'];
}

/**
 * Result and verdict of a set of runs (validation §4.4): ratio, 95% CI (seeded task-stratified bootstrap with a Welch
 * floor, `ratioCi`; null when a counted task has an arm with fewer than 2 runs), pass counts.
 */
export function analyzeRuns(
  runs: readonly Run[],
  exclusions: readonly Exclusion[],
  /**
   * `stop`: why an incomplete record stopped; an interrupted one gets a verdict of at most "likely saving".
   * `metric`: what the ratio measures; absent = cost, exactly the analysis before.
   */
  opts: { seed: number; resamples?: number; status: 'complete' | 'incomplete'; stop?: StopReason; metric?: Metric },
): Analysis {
  const tasks = taskValues(runs, exclusions, opts.metric ?? 'cost');
  const ratio = geometricCostRatio(tasks);
  const ci = ratioCi(tasks, { seed: opts.seed, ...(opts.resamples ? { resamples: opts.resamples } : {}) });
  const passes = passCounts(runs, exclusions);
  const code = capVerdictForStop(printedVerdictCode(ratio, ci), opts.stop);
  const counted = countedRuns(tasks);
  return { result: { costRatio: ratio, ci95: ci, passes }, verdict: { code, text: verdictText(code, ratio, ci, counted, opts.status, opts.stop, opts.metric) } };
}

// ---------------------------------------------------------------------------------------------------------------
// Report (r0 §4 output rules): the verdict on the first line, then ratio, CI, passes, quality bound, the measurement's
// own cost and the plan, then the claim-rule qualifiers (labels.ts). Every line passes `enforceClaims` first.

/**
 * Total tokens and cost of every run the comparison made, excluded runs included (validation §4.5). Tokens: the
 * top-level usage fields, as before under the tokens metric the token use of the metric (`runTokens`, summed over
 * models), so the measurement cost and the verdict count the same tokens.
 */
export function measurementCost(record: Pick<ComparisonRecordV1, 'runs' | 'metric'>): { usd: number; tokens: number; runs: number } {
  let cost = 0;
  let tokens = 0;
  const tokenMetric = record.metric === 'tokens';
  for (const r of record.runs) {
    const m = r.metrics;
    cost += m.totalCostUsd;
    tokens += tokenMetric ? runTokens(m) : m.inputTokens + m.cacheCreation5mTokens + m.cacheCreation1hTokens + m.cacheReadTokens + m.outputTokens;
  }
  return { usd: cost, tokens, runs: record.runs.length };
}

/**
 * The report of a comparison record. Labels: the record's own `labels` (schema 1.2.0), else derived from its `auth`
 * and `opts.billing` (the user's current billing mode; records written before).
 */
export function formatReport(record: ComparisonRecordV1, opts: { billing?: CostLabels['billing'] | null } = {}): string[] {
  const labels = recordLabels(record, opts.billing ?? null);
  const label = costLabelText(labels.measurementCost);
  const { result, plan } = record;
  const p = result.passes;
  const q = qualityBound(p);
  const cost = measurementCost(record);
  const lines = [recordVerdictText(record)];
  const tokens = recordMetric(record) === 'tokens';
  if (tokens) {
    lines.push(
      result.costRatio !== null && result.ci95 !== null
        ? `  token ratio:      ${result.costRatio.toFixed(3)} changed ÷ baseline, 95% CI ${result.ci95[0].toFixed(3)}–${result.ci95[1].toFixed(3)} (geometric mean of token use per run, task-stratified bootstrap with a Welch floor)`
        : result.costRatio !== null
          ? `  token ratio:      ${result.costRatio.toFixed(3)} changed ÷ baseline, no interval (a task arm has fewer than 2 counted runs)`
          : '  token ratio:      not computable',
    );
    lines.push(TOKEN_METRIC_LINE);
    const parts = componentRatios(record.runs, record.exclusions);
    for (const { key, name } of TOKEN_COMPONENTS) {
      const r = parts[key];
      lines.push(`  ${`${name}:`.padEnd(17)} ${r === null ? 'not computable (no tokens of this kind in an arm)' : `${r.toFixed(3)} changed ÷ baseline`} – descriptive only, no interval, no verdict`);
    }
  } else lines.push(
    result.costRatio !== null && result.ci95 !== null
      ? `  cost ratio:       ${result.costRatio.toFixed(3)} changed ÷ baseline, 95% CI ${result.ci95[0].toFixed(3)}–${result.ci95[1].toFixed(3)} (geometric mean, task-stratified bootstrap with a Welch floor)`
      : result.costRatio !== null
        ? `  cost ratio:       ${result.costRatio.toFixed(3)} changed ÷ baseline, no interval (a task arm has fewer than 2 counted runs)`
        : '  cost ratio:       not computable',
  );
  lines.push(`  saving counts as: ${savingMeaning(labels)}`);
  lines.push(`  passes:           baseline ${p.baseline.passed}/${p.baseline.total}, changed ${p.changed.passed}/${p.changed.total} (your success commands)`);
  if (q)
    lines.push(
      `  quality:          no drop larger than ${Math.ceil(q.maxDropPp)} pp detected on your success commands (${p.changed.total} runs; ${q.method === 'rule-of-three' ? 'rule of three' : 'exact binomial bound'})${q.observedDropPp > 0 ? `, observed drop ${q.observedDropPp.toFixed(0)} pp` : ''}`,
    );
  lines.push(`  measurement cost: ${usd(cost.usd)} and ${cost.tokens.toLocaleString('en-US')} tokens over ${cost.runs} runs (${label})`);
  lines.push(`  plan:             planned MDE ${pct(plan.mde)} (${tokens ? 'token use; ' : ''}CI excludes 1.0; ${pct(1 - VERDICT_THRESHOLDS.provenUpper * (1 - plan.mde))} for CI upper ≤ ${VERDICT_THRESHOLDS.provenUpper.toFixed(2)}) at n = ${plan.runsPerArm} per arm (CV ${plan.cv.toFixed(2)}), expected cost at most ${usd(plan.expectedCostUsd)}${plan.paybackMonths != null ? `, payback ${plan.paybackMonths.toFixed(2)} months` : ''} (${label})`);
  if (record.exclusions.length) {
    const counts = new Map<string, number>();
    for (const e of record.exclusions) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    lines.push(`  excluded runs:    ${[...counts].map(([r, n]) => `${n} ${r}`).join(', ')}`);
  }
  const perArm = modelByArmText(record.versions.modelByArm);
  lines.push(`  pinned:           Claude Code ${record.versions.claudeCode}, ${perArm ? `model ${perArm}` : `model ${record.versions.model}`}; status ${record.status}`);
  lines.push(MEASURING_QUALIFIER);
  lines.push(SCOPE_QUALIFIER);
  return enforceClaims(lines, { labels, report: true, metric: recordMetric(record) });
}

/**
 * The labels of a record: its stored `labels`, else derived from `auth` and the given billing mode. Either way the
 * model-change rule (L6, labels.ts `withModelChange`) applies to the arms' resolved models, so a record stored before
 * the rule with different models per arm no longer reports a plan-capacity saving.
 */
export function recordLabels(record: Pick<ComparisonRecordV1, 'auth' | 'labels'> & { versions?: Pick<ComparisonRecordV1['versions'], 'modelByArm'> }, billing: CostLabels['billing'] | null): CostLabels {
  const models = record.versions?.modelByArm;
  if (record.labels) return withModelChange(record.labels, models);
  return costLabels(record.auth, billing === 'unset' ? null : billing, models);
}
