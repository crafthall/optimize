// the README, the marketplace listing and the npm description. Pure: takes a text and its kind, returns the findings.
// copy-check.test.ts runs it on the three files (and the plugin manifest's description) and proves every rule catches

/** Kinds of public text: `full` = README and marketplace body; `short` = the npm description (one line, no room for
 */
export type CopyKind = 'full' | 'short';

export interface CopyFinding {
  rule: string;
  match: string;
}

/** The W11 footer, word for word. */
export const W11_FOOTER = 'Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.';

/** Claims no public text may make (legal note §2.3: establishment and unqualified quality claims, absolute data claims). */
export const BANNED: readonly [string, RegExp][] = [
  ['"proves"', /\bproves\b/i],
  ['"verified quality"', /\bverified quality\b/i],
  ['"quality unchanged"', /\bquality (?:is |stays |remains )?unchanged\b/i],
  ['"no quality loss"', /\bno (?:loss of quality|quality loss)\b/i],
  ['"nothing leaves"', /\bnothing leaves\b/i],
  ['"you saved"', /\byou(?:'ve| have)? saved\b/i],
  ['"up to" + percentage', /\bup to\s+[0-9]+(?:[.,][0-9]+)?\s*(?:%|percent\b|per cent\b)/i],
];

/** Billing qualifier (legal note §2.2 item 2): the four labels and the client-side-estimate caveat. */
export const BILLING_LABELS: readonly string[] = ['API billing', 'API-equivalent estimate', 'subscription capacity', 'usage credits'];
export const BILLING_CAVEAT = "Claude Code's client-side estimate; your bill may differ";

/** Findings for one public text. */
export function copyFindings(text: string, kind: CopyKind): CopyFinding[] {
  const out: CopyFinding[] = [];
  for (const [rule, re] of BANNED) {
    const m = re.exec(text);
    if (m) out.push({ rule: `banned claim ${rule}`, match: m[0] });
  }
  if (!text.includes(W11_FOOTER)) out.push({ rule: 'missing W11 footer', match: W11_FOOTER });
  if (kind === 'full') {
    if (!/^(?:#{1,6}\s+Data|\*\*Data\*\*)\s*$/m.test(text)) out.push({ rule: 'missing Data section', match: '## Data or **Data**' });
    for (const label of BILLING_LABELS) if (!text.includes(label)) out.push({ rule: 'missing billing qualifier', match: label });
    if (!text.includes(BILLING_CAVEAT)) out.push({ rule: 'missing billing qualifier', match: BILLING_CAVEAT });
  }
  return out;
}
