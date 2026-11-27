// `config set billing <api|subscription|credits>` and the billing-mode lookup of every report (R0-10; release
// r0 §4). The mode is asked once and stored locally in the git-ignored store; it decides the cost labels
// (@crafthall/optimize-engine labels.ts). Unset and no terminal: nothing is stored and the reports use the
// "API-equivalent estimate" label with the subscription qualifier.
import { BILLING_MODES, isBillingMode, readBilling, STORE_DIR, writeBilling, type BillingMode } from '@crafthall/optimize-engine';
import { BIN_NAME } from './brand';
import type { CliDeps } from './deps';
import { EXIT, type Io } from './exit';
import { guarded, parse, repoRootOf, UsageError, type Handler } from './fixture';

export const BILLING_QUESTION =
  'How do you pay for Claude Code? api = per-token API billing, subscription = Pro, Max or Ultra plan, credits = usage credits [api/subscription/credits]: ';
export const BILLING_HINT = `Billing mode not set: cost figures are labelled "API-equivalent estimate". Set it once with \`${BIN_NAME} config set billing <${BILLING_MODES.join('|')}>\`.`;

/** What each mode means for the cost label, printed by `config set billing`. */
const MEANING: Readonly<Record<BillingMode, string>> = {
  api: 'cost figures are labelled "API billing"',
  subscription: 'cost figures are labelled "subscription capacity": a saving is plan capacity, not money',
  credits: 'cost figures are labelled "usage credits"',
};

export const configSet: Handler = (args, io, deps) =>
  guarded(io, () => {
    const { positionals } = parse(args, {});
    const [key, value, ...extra] = positionals;
    if (key !== 'billing' || extra.length) throw new UsageError(`expected: config set billing <${BILLING_MODES.join('|')}>`);
    if (!isBillingMode(value)) throw new UsageError(`billing must be one of ${BILLING_MODES.join(', ')}`);
    writeBilling(deps.fs, repoRootOf(deps), value);
    io.out(`Billing mode set to ${value}: ${MEANING[value]}. Stored in ${STORE_DIR}/config.json (local, git-ignored).`);
    return EXIT.ok;
  });

/**
 * The billing mode for a report: the stored value; when unset, asks once on the terminal and stores a valid answer;
 * no terminal or no valid answer → null (nothing stored, `say` prints the hint).
 */
export function resolveBilling(deps: CliDeps, repoRoot: string, say: Io['err']): BillingMode | null {
  const stored = readBilling(deps.fs, repoRoot);
  if (stored) return stored;
  const answer = deps.ask?.(BILLING_QUESTION)?.trim().toLowerCase() ?? null;
  if (isBillingMode(answer)) {
    writeBilling(deps.fs, repoRoot, answer);
    say(`Billing mode set to ${answer}: ${MEANING[answer]}. Change it with \`${BIN_NAME} config set billing\`.`);
    return answer;
  }
  say(BILLING_HINT);
  return null;
}
