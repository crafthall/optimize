// Four cost labels and the claim rules (R0-10, R0-11; feature doc cost-labels.md; legal note
// carries and that checks every report line against the claim rules. Pure: no I/O. Shared by `compare`, `report`,
// `--json` and `import-usage` (: the "estimated, not measured / not measurable" labels and its output lines).

/** The user's billing mode (`config set billing`, asked once, stored locally). */
export type BillingMode = 'api' | 'subscription' | 'credits';
export const BILLING_MODES: readonly BillingMode[] = ['api', 'subscription', 'credits'];
export const isBillingMode = (v: unknown): v is BillingMode => typeof v === 'string' && (BILLING_MODES as readonly string[]).includes(v);

/** Auth mode of the runs (mirrors records.ts `AuthMode`; absent in 1.0.0 records). */
type Auth = 'api-key' | 'subscription' | undefined;

export type CostLabelCode = 'api-billing' | 'api-equivalent-estimate' | 'subscription-capacity' | 'usage-credits';
export const COST_LABEL_CODES: readonly CostLabelCode[] = ['api-billing', 'api-equivalent-estimate', 'subscription-capacity', 'usage-credits'];

/** The four label names (legal note §2.2 item 2). Every cost figure carries exactly one of them. */
export const COST_LABEL_NAMES: Readonly<Record<CostLabelCode, string>> = {
  'api-billing': 'API billing',
  'api-equivalent-estimate': 'API-equivalent estimate',
  'subscription-capacity': 'subscription capacity',
  'usage-credits': 'usage credits',
};

/** Anthropic's own caveat on `total_cost_usd` (headless docs; legal note §2.2 item 2). */
export const CLIENT_SIDE_ESTIMATE = "Claude Code's client-side estimate; your bill may differ";

/** Qualifier 1, the "estimated" half: for figures that were not measured by paired runs (import-usage). */
export const ESTIMATED_NOT_MEASURED = 'estimated, not measured';
/** Qualifier 1 for an estimate whose expected effect is below what a paired comparison can detect (import-usage). */
export const ESTIMATED_NOT_MEASURABLE = 'estimated, not measurable';

/** Qualifier 3 (subscription). */
export const SUBSCRIPTION_QUALIFIER = 'On a Pro, Max or Ultra plan a saving is plan capacity, not money; it does not lower your subscription price.';
/** Qualifier 6 (cost of measuring). */
export const MEASURING_QUALIFIER = 'Comparisons run on your own Claude account and use your tokens or plan capacity; the expected cost is shown before anything runs.';
/** Qualifier 7 (scope). */
export const SCOPE_QUALIFIER = 'Results hold for your tasks, model and Claude Code version; re-measure after updates.';

/** The full label text printed next to a cost figure: one label name plus the client-side-estimate note. */
export function costLabelText(code: CostLabelCode): string {
  if (code === 'subscription-capacity') return `${COST_LABEL_NAMES[code]} valued at API list price, not money you pay – ${CLIENT_SIDE_ESTIMATE}`;
  return `${COST_LABEL_NAMES[code]} – ${CLIENT_SIDE_ESTIMATE}`;
}

/**
 * Label of what the comparison itself spends (plan block, measurement cost). The runs' auth decides who pays:
 * `--auth api-key` runs are billed to the user's API key; `--auth subscription` runs use the user's own login, so
 * they consume plan capacity – or usage credits, or API billing when the login is a per-token (Console) account.
 * Records without `auth` (schema 1.0.0) fall back to the billing mode; with neither, the list-price figure is only an
 * API-equivalent estimate.
 */
export function measurementLabel(auth: Auth, billing: BillingMode | null): CostLabelCode {
  if (auth === 'api-key') return 'api-billing';
  if (billing === 'api') return 'api-billing';
  if (billing === 'credits') return 'usage-credits';
  if (billing === 'subscription' || auth === 'subscription') return 'subscription-capacity';
  return 'api-equivalent-estimate';
}

/**
 * The resolved model of each arm (structurally `versions.modelByArm`; compare.ts `ModelByArm`, kept local so this file
 * imports nothing).
 */
export type ArmModels = Partial<Record<'baseline' | 'changed', string>>;

/**
 * Legal review L6 (crafthall-optimize-legal.md §8.8): printed when the arms ran different models on plan or credits
 * billing. Plan limits are not published per model, so a token or list-price saving does not translate into plan capacity.
 */
export const MODEL_CHANGE_NOTE = 'Anthropic does not publish how plan limits weight models, so no plan-capacity saving is claimed.';

/** True when both arms have a resolved model and the two differ (an arm without a model: unknown, not a change). */
export function armModelsDiffer(models: ArmModels | undefined): boolean {
  const b = models?.baseline;
  const c = models?.changed;
  return !!b && !!c && b !== c;
}

/**
 * Label of what a saving means for the user's everyday Claude Code use – decided by the billing mode, except that a
 * comparison whose arms ran different models on subscription or credits billing claims no plan-capacity saving (L6):
 * its saving is only an API-equivalent estimate. API billing is per token at published per-model prices, so it keeps
 * its label.
 */
export function savingLabel(billing: BillingMode | null, modelChange = false): CostLabelCode {
  if (billing === 'api') return 'api-billing';
  if (modelChange && (billing === 'subscription' || billing === 'credits')) return 'api-equivalent-estimate';
  if (billing === 'subscription') return 'subscription-capacity';
  if (billing === 'credits') return 'usage-credits';
  return 'api-equivalent-estimate';
}

/** The `labels` field of a comparison record (schema 1.2.0) and of `--json` output. */
export interface CostLabels {
  billing: BillingMode | 'unset';
  measurementCost: CostLabelCode;
  saving: CostLabelCode;
}

/** Labels from the runs' auth and the billing mode; `models` (the arms' resolved models, once known) applies L6. */
export function costLabels(auth: Auth, billing: BillingMode | null, models?: ArmModels): CostLabels {
  return { billing: billing ?? 'unset', measurementCost: measurementLabel(auth, billing), saving: savingLabel(billing, armModelsDiffer(models)) };
}

/**
 * Applies L6 to labels already computed (the plan block's labels before the runs, or labels stored by a record written
 * before the rule): different models on subscription or credits billing → the saving is an API-equivalent estimate.
 * The measurement cost label is unchanged – the runs did use plan capacity or credits.
 */
export function withModelChange(labels: CostLabels, models: ArmModels | undefined): CostLabels {
  if (!armModelsDiffer(models) || (labels.billing !== 'subscription' && labels.billing !== 'credits')) return labels;
  return labels.saving === 'api-equivalent-estimate' ? labels : { ...labels, saving: 'api-equivalent-estimate' };
}

/** True when the labels are the L6 case: plan or credits billing whose saving is only an API-equivalent estimate. */
export const isModelChangeSaving = (labels: CostLabels): boolean =>
  (labels.billing === 'subscription' || labels.billing === 'credits') && labels.saving === 'api-equivalent-estimate';

/** One line on what a saving means for this billing mode (qualifier 3 for subscription; never a currency amount). */
export function savingMeaning(labels: CostLabels): string {
  if (isModelChangeSaving(labels))
    return `${COST_LABEL_NAMES['api-equivalent-estimate']}: ${MODEL_CHANGE_NOTE}${labels.billing === 'subscription' ? ` ${SUBSCRIPTION_QUALIFIER}` : ''}`;
  switch (labels.billing) {
    case 'api':
      return `${COST_LABEL_NAMES['api-billing']}: a saving lowers your per-token cost (${CLIENT_SIDE_ESTIMATE}).`;
    case 'subscription':
      return `${COST_LABEL_NAMES['subscription-capacity']}: ${SUBSCRIPTION_QUALIFIER}`;
    case 'credits':
      return `${COST_LABEL_NAMES['usage-credits']}: a saving means fewer usage credits used (${CLIENT_SIDE_ESTIMATE}).`;
    default:
      return `${COST_LABEL_NAMES['api-equivalent-estimate']} (billing mode not set; run \`crafthall-optimize config set billing <api|subscription|credits>\`): ${SUBSCRIPTION_QUALIFIER}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Claim rules. `claimViolations` is the single check every report and plan block passes before it is printed; the
// property tests run it (and their own independent assertions) over generated records.

/** Wording no output may contain (legal note §2.2 item 5, §2.3 W1-W4, r0 R0-11). "proven" (in "not proven") is allowed. */
export const FORBIDDEN_CLAIMS: readonly RegExp[] = [
  /quality unchanged/i,
  /verified[- ]quality/i,
  /no quality loss/i,
  /\bsafe\b/i,
  /\bproves?\b/i,
  /nothing leaves/i,
  /you saved/i,
];

/** A currency amount: "USD 1.20", "$1.20", "1.20 USD", "EUR 3", "€3". */
export const CURRENCY_AMOUNT = /(?:\b(?:USD|EUR|CHF|GBP)\s?\d|[$€£]\s?\d|\d\s?(?:USD|EUR|CHF|GBP)\b)/;
const SAVING_WORD = /\bsav(?:e|ed|es|ing|ings)\b/i;
/** A printed 95% interval, e.g. "95% CI 0.702–1.000". */
const PRINTED_CI = /95% CI (\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?)/g;

export interface ClaimContext {
  labels: CostLabels;
  /** True for the report of a comparison (qualifiers 1, 4, 6, 7 must be present); false for the plan block. */
  report: boolean;
  /**
   * Metric of the verdict; absent = cost. Under `tokens` no line that states the token result (verdict line,
   * token ratio, a saving in token use) may carry a currency amount.
   */
  metric?: 'tokens' | 'cost';
}

/** A line that states a token-use result. */
const TOKEN_RESULT = /\btoken ratio\b|\bin token use\b/;

export function claimViolations(lines: readonly string[], ctx: ClaimContext): string[] {
  const out: string[] = [];
  const text = lines.join('\n');
  for (const re of FORBIDDEN_CLAIMS) if (re.test(text)) out.push(`forbidden claim ${re}`);
  for (const line of lines) {
    if (!CURRENCY_AMOUNT.test(line)) continue;
    if (ctx.labels.billing !== 'api' && SAVING_WORD.test(line)) out.push(`currency amount next to a saving without per-token billing: "${line}"`);
    const names = Object.values(COST_LABEL_NAMES).filter((n) => line.includes(n));
    if (names.length !== 1) out.push(`cost figure needs exactly one label, has ${names.length}: "${line}"`);
    if (!line.includes("Claude Code's client-side estimate")) out.push(`cost figure without the client-side-estimate note: "${line}"`);
  }
  if (ctx.metric === 'tokens')
    for (const [i, line] of lines.entries())
      if (CURRENCY_AMOUNT.test(line) && (TOKEN_RESULT.test(line) || (ctx.report && i === 0))) out.push(`currency amount in a token-use result: "${line}"`);
  if (!text.includes(MEASURING_QUALIFIER)) out.push('missing qualifier 6 (cost of measuring)');
  if (ctx.report) {
    for (const m of text.matchAll(PRINTED_CI)) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (lo <= 1 && hi >= 1 && !/^Not enough evidence/.test(lines[0] ?? '')) out.push(`printed CI ${m[1]}–${m[2]} contains 1 but the verdict is not "Not enough evidence"`);
    }
    if (!/measured on \d+ runs of your fixtures/.test(lines[0] ?? '')) out.push('missing qualifier 1 (measured on N runs) in the verdict line');
    if (!text.includes(SCOPE_QUALIFIER)) out.push('missing qualifier 7 (scope)');
    if ((ctx.labels.billing === 'subscription' || ctx.labels.billing === 'unset') && !text.includes(SUBSCRIPTION_QUALIFIER)) out.push('missing qualifier 3 (subscription)');
    if (isModelChangeSaving(ctx.labels) && !text.includes(MODEL_CHANGE_NOTE)) out.push('missing the model-change note (L6: no plan-capacity saving across models)');
  }
  return out;
}

export class ClaimViolationError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`claim rules violated (legal note §2.2): ${violations.join('; ')}`);
    this.name = 'ClaimViolationError';
  }
}

/** Throws when the lines break a claim rule – a bug guard: no output reaches the user unless it passes. */
export function enforceClaims(lines: string[], ctx: ClaimContext): string[] {
  const v = claimViolations(lines, ctx);
  if (v.length) throw new ClaimViolationError(v);
  return lines;
}
