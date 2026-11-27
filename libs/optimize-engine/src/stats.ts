// Statistics of a paired before/after comparison (R0-07). Source of truth: validation
// cost ratio, task-stratified bootstrap, pass counts with the rule of three). Pure and deterministic given a seed.

/** Two-sided significance level and power of the plan (validation §3.4: α = 0.05, power 0.80). */
export const ALPHA = 0.05;
export const POWER = 0.8;
/** Bootstrap resamples (validation §3.3 M3, r0 R0-07). */
export const BOOTSTRAP_RESAMPLES = 10_000;
/** CV used when no pilot exists – an assumption the plan labels as such (validation §4.4). */
export const DEFAULT_CV = 0.3;

/**
 * Standard normal quantile Φ⁻¹(p), Peter Acklam's rational approximation (relative error below 1.15e-9 on (0, 1)).
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile: p must be in (0, 1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/** z_{1-α/2} + z_{power}: 1.95996 + 0.84162 = 2.80158 for the defaults. */
export const zSum = (alpha: number = ALPHA, power: number = POWER): number => normalQuantile(1 - alpha / 2) + normalQuantile(power);

/** σ of log cost for a log-normal cost with coefficient of variation `cv`: σ = √ln(1 + CV²) (validation §3.4). */
export function logSigma(cv: number): number {
  if (!(cv > 0) || !Number.isFinite(cv)) throw new RangeError(`cv must be a positive number, got ${cv}`);
  return Math.sqrt(Math.log(1 + cv * cv));
}

/**
 * Runs per arm to detect a cost saving `saving` (fraction, 0.1 = 10%), two arms, task-blocked (validation §3.4):
 * n = 2 · ((z_{1-α/2} + z_{power}) · σ / δ)², σ = √ln(1+CV²), δ = −ln(1−s); rounded up.
 */
export function sampleSizePerArm(cv: number, saving: number, alpha: number = ALPHA, power: number = POWER): number {
  if (!(saving > 0 && saving < 1)) throw new RangeError(`saving must be in (0, 1), got ${saving}`);
  const delta = -Math.log(1 - saving);
  const n = 2 * ((zSum(alpha, power) * logSigma(cv)) / delta) ** 2;
  return Math.ceil(n - 1e-9);
}

/**
 * Minimum detectable saving for `nPerArm` runs per arm (validation §3.4):
 * MDE = 1 − exp(−(z_{1-α/2} + z_{power}) · σ · √(2/n)).
 */
export function minimumDetectableEffect(cv: number, nPerArm: number, alpha: number = ALPHA, power: number = POWER): number {
  if (!(nPerArm >= 1) || !Number.isFinite(nPerArm)) throw new RangeError(`nPerArm must be at least 1, got ${nPerArm}`);
  return 1 - Math.exp(-zSum(alpha, power) * logSigma(cv) * Math.sqrt(2 / nPerArm));
}

// Presentation of the plan with Student t quantiles (Lead decision on QA ruling 1 of the review,
// stats-review-1031.md §9). The reported interval is the union with a Welch t interval, so at T1 sizes the normal
// quantiles above overstate power. The two functions above stay: they reproduce validation §3.4. These print the plan.

/** Degrees of freedom of the plan: 2·K·(m − 1) for K tasks and m runs per arm per task, i.e. 2·(n − K) with n = K·m. */
export const planDegreesOfFreedom = (nPerArm: number, tasks: number): number => 2 * (nPerArm - tasks);

/** t_{1-α/2, df} + t_{power, df}; tends to zSum as df grows. */
export const tSum = (df: number, alpha: number = ALPHA, power: number = POWER): number => studentTQuantile(1 - alpha / 2, df) + studentTQuantile(power, df);

/** Planned MDE (CI excludes 1.0) with t quantiles: 1 − exp(−(t_{0.975,df} + t_{0.80,df}) · σ · √(2/n)); ≈ 80% power. */
export function minimumDetectableEffectT(cv: number, nPerArm: number, df: number): number {
  if (!(nPerArm >= 1) || !(df > 0)) throw new RangeError(`need nPerArm >= 1 and df > 0, got ${nPerArm}, ${df}`);
  return 1 - Math.exp(-tSum(df) * logSigma(cv) * Math.sqrt(2 / nPerArm));
}

/** Saving a "measured saving" verdict (CI upper ≤ 0.85) needs, with t quantiles: 1 − 0.85 · (1 − MDE_t); ≈ 80% power. */
export function measuredSavingMdeT(cv: number, nPerArm: number, df: number): number {
  return 1 - VERDICT_THRESHOLDS.provenUpper * (1 - minimumDetectableEffectT(cv, nPerArm, df));
}

/** Seeded PRNG (mulberry32): a uniform number in [0, 1). Same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Costs of one task (fixture) per arm; non-positive costs are not allowed (filter them before). */
export interface TaskCosts {
  task: string;
  baseline: readonly number[];
  changed: readonly number[];
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Task-stratified log ratio: the mean over tasks of (mean ln cost changed − mean ln cost baseline), equal weight per
 * task (validation §4.1 task blocking, §4.4 geometric-mean cost ratio). Tasks without a run in both arms are dropped.
 */
export function stratifiedLogRatio(tasks: readonly TaskCosts[]): number | null {
  const usable = tasks.filter((t) => t.baseline.length && t.changed.length);
  if (!usable.length) return null;
  return mean(usable.map((t) => mean(t.changed.map(Math.log)) - mean(t.baseline.map(Math.log))));
}

/** Geometric-mean cost ratio changed ÷ baseline, exp(stratifiedLogRatio); null when no task has both arms. */
export function geometricCostRatio(tasks: readonly TaskCosts[]): number | null {
  const d = stratifiedLogRatio(tasks);
  return d === null ? null : Math.exp(d);
}

/** Linear-interpolation quantile (type 7) of a sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * 95% percentile interval of the geometric-mean cost ratio by task-stratified bootstrap: each resample draws, within
 * every task, the baseline runs and the changed runs with replacement (same sizes), and recomputes the stratified log
 * ratio. Deterministic for a given seed. Returns null when no task has both arms.
 */
export function bootstrapRatioCi(
  tasks: readonly TaskCosts[],
  options: { seed: number; resamples?: number; level?: number },
): [number, number] | null {
  const usable = tasks.filter((t) => t.baseline.length && t.changed.length).map((t) => ({ a: t.baseline.map(Math.log), b: t.changed.map(Math.log) }));
  if (!usable.length) return null;
  const resamples = options.resamples ?? BOOTSTRAP_RESAMPLES;
  const level = options.level ?? 0.95;
  const rand = mulberry32(options.seed);
  const draw = (xs: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rand() * xs.length)]!;
    return s / xs.length;
  };
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (const t of usable) {
      const ma = draw(t.a);
      const mb = draw(t.b);
      sum += mb - ma;
    }
    stats[r] = sum / usable.length;
  }
  const sorted = Array.from(stats).sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return [Math.exp(quantileSorted(sorted, tail)), Math.exp(quantileSorted(sorted, 1 - tail))];
}

/** True when the interval contains 1.0 (bounds inclusive): the report must say "not enough evidence" (legal note §2.2 item 4). */
export const ciContainsOne = (ci: readonly [number, number]): boolean => ci[0] <= 1 && ci[1] >= 1;

/** ln Γ(x) for x > 0 (Lanczos, g = 7, 9 terms; relative error about 1e-15). */
function lnGamma(x: number): number {
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = g[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += g[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction of the incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < tiny ? tiny : d);
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    for (const num of [(m * (b - m) * x) / ((a + m2 - 1) * (a + m2)), (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))]) {
      d = 1 + num * d;
      d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + num / c;
      if (Math.abs(c) < tiny) c = tiny;
      h *= d * c;
    }
    if (Math.abs(d * c - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) for a, b > 0 and x in [0, 1]. */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Student t quantile t_p(df) for p in [0.5, 1) and df > 0 (real df allowed, for Welch–Satterthwaite), by bisection. */
export function studentTQuantile(p: number, df: number): number {
  if (!(p >= 0.5 && p < 1) || !(df > 0)) throw new RangeError(`studentTQuantile: need p in [0.5, 1) and df > 0, got ${p}, ${df}`);
  // P(T > t) = I_{df/(df+t²)}(df/2, 1/2) / 2
  const upperTail = (t: number) => regularizedBeta(df / (df + t * t), df / 2, 0.5) / 2;
  let lo = 0;
  let hi = 1;
  while (upperTail(hi) > 1 - p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (upperTail(mid) > 1 - p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Exact (Clopper–Pearson) one-sided upper confidence bound on a binomial rate with `x` events in `n` trials:
 * the p with P(X ≤ x | p) = 1 − level, i.e. the `level` quantile of Beta(x + 1, n − x). 1 when x = n.
 */
export function binomialUpper(x: number, n: number, level = 0.95): number {
  if (!(n >= 1) || !(x >= 0 && x <= n)) throw new RangeError(`binomialUpper: need 0 <= x <= n, n >= 1, got ${x}, ${n}`);
  if (x === n) return 1;
  // P(X ≤ x | p) = 1 − I_p(x + 1, n − x), falling in p
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (1 - regularizedBeta(mid, x + 1, n - x) > 1 - level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Welch interval of the task-stratified log ratio: the estimator is the mean over K tasks of (mean ln changed − mean
 * ln baseline), so its variance is Σ_k (s²_{k,changed}/m_{k,changed} + s²_{k,baseline}/m_{k,baseline}) / K², with
 * Welch–Satterthwaite degrees of freedom. Returns the interval on the ratio scale, or null when no task has both arms
 * or any counted task has an arm with fewer than 2 runs (no variance estimate). QA review §2: at T1 sizes
 * the plain percentile bootstrap under-covers (0.90 for a nominal 0.95 at 3 tasks × 4 runs), this interval does not.
 */
export function welchRatioCi(tasks: readonly TaskCosts[], level = 0.95): [number, number] | null {
  const usable = tasks.filter((t) => t.baseline.length && t.changed.length);
  if (!usable.length || usable.some((t) => t.baseline.length < 2 || t.changed.length < 2)) return null;
  const k2 = usable.length ** 2;
  let variance = 0;
  let dfDen = 0;
  for (const t of usable)
    for (const xs of [t.baseline.map(Math.log), t.changed.map(Math.log)]) {
      const m = mean(xs);
      const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length / k2;
      variance += v;
      dfDen += (v * v) / (xs.length - 1);
    }
  const d = stratifiedLogRatio(usable)!;
  if (!(variance > 0)) return [Math.exp(d), Math.exp(d)];
  const half = studentTQuantile(1 - (1 - level) / 2, (variance * variance) / dfDen) * Math.sqrt(variance);
  return [Math.exp(d - half), Math.exp(d + half)];
}

/**
 * The reported 95% interval of the cost ratio: the task-stratified percentile bootstrap (validation §3.3 M3, §4.4)
 * widened, where it is narrower, to the Welch interval – the union of both. The bootstrap stays the specified method;
 * the Welch floor restores coverage at small n per task (QA review §2). Null when no task has both arms or
 * any counted task has an arm with fewer than 2 runs, so the verdict is "not enough evidence".
 */
export function ratioCi(tasks: readonly TaskCosts[], options: { seed: number; resamples?: number; level?: number }): [number, number] | null {
  const boot = bootstrapRatioCi(tasks, options);
  const welch = welchRatioCi(tasks, options.level ?? 0.95);
  if (!boot || !welch) return null;
  return [Math.min(boot[0], welch[0]), Math.max(boot[1], welch[1])];
}

/**
 * Quality harm bound (validation §3.4 rule of three, §4.4 wording "no drop larger than X pp detected").
 * The drop in pass rate (baseline − changed) can never exceed the changed arm's failure rate, so a one-sided 95% upper
 * bound on that failure rate bounds the drop for every baseline pass rate. With zero failures in n changed runs this
 * is the rule of three, 300/n pp (the validation's wording; slightly above the exact 1 − 0.05^(1/n)); with failures it
 * is the exact Clopper–Pearson bound, never below 300/n (QA review §4: the earlier "observed drop + 300/n" covered only 86.5%
 * at 12 vs 12 runs). `ruleOfThreePp` is kept for the report. Null when an arm has no runs.
 */
export function qualityBound(passes: { baseline: { passed: number; total: number }; changed: { passed: number; total: number } }): {
  observedDropPp: number;
  ruleOfThreePp: number;
  maxDropPp: number;
  method: 'rule-of-three' | 'exact-binomial';
} | null {
  const { baseline: a, changed: b } = passes;
  if (!a.total || !b.total) return null;
  const observedDropPp = 100 * (a.passed / a.total - b.passed / b.total);
  const ruleOfThreePp = 300 / b.total;
  const failures = b.total - b.passed;
  if (failures === 0) return { observedDropPp, ruleOfThreePp, maxDropPp: Math.min(100, ruleOfThreePp), method: 'rule-of-three' };
  // Never below the zero-failure bound: at n ≤ 3 the rule of three (capped at 100) exceeds the exact bound for one failure.
  return { observedDropPp, ruleOfThreePp, maxDropPp: Math.min(100, Math.max(ruleOfThreePp, 100 * binomialUpper(failures, b.total))), method: 'exact-binomial' };
}

/** Verdict thresholds (validation §3.3 M3, applied per comparison). */
export const VERDICT_THRESHOLDS = { provenUpper: 0.85, likelyPoint: 0.9 } as const;

export type VerdictCode = 'measured-saving' | 'likely-saving' | 'not-enough-evidence';

/**
 * Verdict of a comparison (validation §3.3 M3, legal note §2.2 item 4):
 * - no ratio or CI, or the CI contains 1.0 → not-enough-evidence;
 * - CI upper bound ≤ 0.85 → measured-saving;
 * - point estimate ≤ 0.90 (CI below 1.0 but its upper bound above 0.85) → likely-saving ("likely saving, not proven");
 * - otherwise (a saving under 10%, or the change costs more) → not-enough-evidence of a material saving.
 */
export function verdictCode(ratio: number | null, ci: readonly [number, number] | null): VerdictCode {
  if (ratio === null || ci === null || ciContainsOne(ci)) return 'not-enough-evidence';
  if (ci[1] <= VERDICT_THRESHOLDS.provenUpper) return 'measured-saving';
  if (ratio <= VERDICT_THRESHOLDS.likelyPoint) return 'likely-saving';
  return 'not-enough-evidence';
}

/** Payback horizon refusal threshold in months (validation §4.5). */
export const PAYBACK_LIMIT_MONTHS = 3;

/**
 * Break-even horizon in months = expected measurement cost ÷ (estimated saving × monthly volume) (validation §4.5).
 * Null when the monthly volume is unknown or the saving is 0 (the horizon cannot be computed).
 */
export function paybackMonths(expectedCost: number, estimatedSaving: number, monthlyVolume: number | null): number | null {
  if (monthlyVolume === null || !(monthlyVolume > 0) || !(estimatedSaving > 0)) return null;
  return expectedCost / (estimatedSaving * monthlyVolume);
}
