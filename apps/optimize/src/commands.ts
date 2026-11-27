// The command table of the CLI (release r0 §4). Each command is filled by its own issue; until then the router
// answers with exit code 2 and names the issue. Order = order in --help.

export interface CommandSpec {
  /** Words that select the command, e.g. ['fixture', 'add']. */
  path: readonly string[];
  usage: string;
  summary: string;
  /** Issue that builds the command; `null` once it is built. */
  plannedIn: number | null;
}

export const COMMANDS: readonly CommandSpec[] = [
  { path: ['fixture', 'add'], usage: 'fixture add <name> --prompt <file> --check "<cmd>" [--commit <sha>] [--timeout-min <n>] [--max-budget-usd <n>]', summary: 'Freeze a task: repo at a commit, prompt file (hash only), success command, caps', plannedIn: null },
  { path: ['fixture', 'list'], usage: 'fixture list [--json]', summary: 'List the fixtures of this repository', plannedIn: null },
  { path: ['fixture', 'remove'], usage: 'fixture remove <name> [--json]', summary: 'Delete a fixture', plannedIn: null },
  { path: ['config', 'set'], usage: 'config set billing <api|subscription|credits>', summary: 'Store the billing mode that drives the cost labels (asked once by every report when unset)', plannedIn: null },
  { path: ['import-usage'], usage: 'import-usage [--usage-file <file>] [--read-transcripts <dir>] [--otel <file>] [--json]   (or paste the /usage rows on stdin)', summary: 'Hypotheses from pasted /usage rows and the non-native checks D2, D3, D5, D6 (estimated, not measured); reads session records only with --read-transcripts; --otel is not built yet', plannedIn: null },
  { path: ['usage'], usage: 'usage [--read-transcripts <dir>] [--days <n>] [--usage-file <file|->] [--json]', summary: "Tokens this repository's Claude Code sessions used (last 7 days by default), where they went (D1-D6, estimated) and ranked fixes; reads usage fields only", plannedIn: null },
  {
    path: ['compare'],
    usage:
      'compare --change <patch-file> [--fixtures <a,b,c>] [--runs-per-arm <n>] [--cv <x>] [--monthly-volume <usd>] [--max-budget-usd <n>] [--max-runs <n>] [--auth <api-key|subscription>] [--metric <tokens|cost>] [--trust-fixture-config] [--plan-only] [--yes] [--force] [--json]',
    summary: 'Paired before/after of one change (verdict on token use or cost); prints the plan first and asks before any run',
    plannedIn: null,
  },
  { path: ['report'], usage: 'report <record.json|id> [--redact] [--json]', summary: 'Re-print a stored comparison record; --redact gives a share-safe copy', plannedIn: null },
];

/** The command whose path is a prefix of argv, longest match first. */
export function matchCommand(argv: readonly string[]): CommandSpec | undefined {
  return [...COMMANDS].sort((a, b) => b.path.length - a.path.length).find((c) => c.path.every((w, i) => argv[i] === w));
}
