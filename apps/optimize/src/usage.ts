// `usage` (R1-20): token usage of this repository's Claude Code sessions – totals by component, model, day,
// main conversation vs subagents, top sessions – the share behind each non-native check D1–D6, and the ranked fixes
// of import-usage. Default source: this repository's project folder under ~/.claude/projects/ (the repo path with every
// character that is not a letter or digit replaced by `-`, the way Claude Code names it); `--read-transcripts <dir>`
// reads another folder. Reads usage fields only (transcripts.ts), stores nothing, makes no network call.
import { isAbsolute, resolve } from 'node:path';
import {
  buildTokenUsage,
  costLabels,
  DEFAULT_USAGE_DAYS,
  emptyTranscriptStats,
  enforceClaims,
  formatTokenUsage,
  MAX_USAGE_DAYS,
  outputLeaks,
  parseUsageText,
  printableSessionId,
  readBilling,
  readSessionFields,
  UsageParseError,
  type ParsedUsage,
  type TokenUsageReport,
  type TranscriptStats,
  type UsageSession,
} from '@crafthall/optimize-engine';
import { BIN_NAME } from './brand';
import type { CliDeps } from './deps';
import { EXIT } from './exit';
import { guarded, parse, repoRootOf, UsageError, type Handler } from './fixture';
import { collectConfig } from './import-usage';

/** Name of a repository's folder under ~/.claude/projects/: every character that is not a letter or digit becomes `-`. */
export const projectFolderName = (repoRoot: string): string => repoRoot.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Usage fields of the session files (`*.jsonl`) in `dir` and of their `<session>/subagents/*.jsonl` files, one file at
 * a time (its text is dropped before the next is read). A file is named by its session id when that is a UUID, else
 * `session-N` (a file name is never printed as it is).
 */
export function readUsageFolder(deps: CliDeps, dir: string): { sessions: UsageSession[]; stats: TranscriptStats } {
  const stats = emptyTranscriptStats();
  const sessions: UsageSession[] = [];
  const names = new Map<string, string>();
  let unnamed = 0;
  const idOf = (name: string): string => {
    let id = names.get(name);
    if (!id) names.set(name, (id = printableSessionId(name) ?? `session-${++unnamed}`));
    return id;
  };
  const read = (path: string, id: string, subagent: boolean): void => {
    const text = deps.readFile(path);
    if (text !== undefined) sessions.push({ id, subagent, fields: readSessionFields(text, stats) });
  };
  for (const name of deps.fs.list(dir).sort()) {
    if (name.endsWith('.jsonl')) read(`${dir}/${name}`, idOf(name.slice(0, -'.jsonl'.length)), false);
    else
      for (const sub of deps.fs.list(`${dir}/${name}/subagents`).sort())
        if (sub.endsWith('.jsonl')) read(`${dir}/${name}/subagents/${sub}`, idOf(name), true);
  }
  stats.sessions = sessions.length;
  return { sessions, stats };
}

function parseDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_USAGE_DAYS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_USAGE_DAYS) throw new UsageError(`--days must be a whole number from 1 to ${MAX_USAGE_DAYS}, got "${raw}"`);
  return Number(raw);
}

/** The report for the given argv; exported for the unit tests (no output). */
export function usageReport(args: readonly string[], deps: CliDeps): { report: TokenUsageReport; json: boolean } {
  const { values, positionals } = parse(args, {
    'read-transcripts': { type: 'string' },
    days: { type: 'string' },
    'usage-file': { type: 'string' },
    json: { type: 'boolean' },
  });
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const days = parseDays(values.days);
  const repoRoot = repoRootOf(deps);
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(deps.cwd, p));

  let usage: ParsedUsage | null = null;
  const usageFile = values['usage-file'];
  if (usageFile !== undefined) {
    const text = usageFile === '-' ? (deps.readStdin?.() ?? '') : deps.readFile(abs(usageFile));
    if (text === undefined) throw new UsageError('the --usage-file was not found or is not a file');
    try {
      const parsed = parseUsageText(text);
      usage = parsed.recognized ? parsed : null;
    } catch (e) {
      if (e instanceof UsageParseError) throw new UsageError(e.message);
      throw e;
    }
  }

  const given = values['read-transcripts'];
  let dir: string;
  if (given !== undefined) dir = abs(given);
  else {
    const home = deps.homeDir?.() ?? null;
    if (!home) throw new UsageError('cannot find your home directory; pass --read-transcripts <dir> (a folder under ~/.claude/projects/)');
    dir = `${home.replace(/[\\/]+$/, '')}/.claude/projects/${projectFolderName(repoRoot)}`;
  }
  const { sessions, stats } = readUsageFolder(deps, dir);
  if (!sessions.length)
    throw new UsageError(
      given !== undefined
        ? 'no session records (*.jsonl) in the folder given to --read-transcripts; pass a folder under ~/.claude/projects/'
        : "no session records for this repository in Claude Code's project folder (~/.claude/projects/); run Claude Code here first or pass --read-transcripts <dir>",
    );

  const identities = [...deps.git.identities(repoRoot), ...deps.machineIdentities()];
  const report = buildTokenUsage({
    sessions,
    stats,
    now: deps.now(),
    days,
    source: given !== undefined ? 'read-transcripts' : 'project-folder',
    usage,
    config: collectConfig(deps, repoRoot),
    identities,
    repoRoot,
    home: deps.homeDir?.() ?? undefined,
    bin: BIN_NAME,
  });
  const leaks = outputLeaks(report, identities);
  if (leaks.length) throw new Error(`privacy guard stopped the output (${leaks.map((l) => `${l.kind} at ${l.path}`).join(', ')})`);
  // Claim rules: every line Optimize writes itself passes; pasted /usage wording is left out (ownWording).
  // Same placeholder as import-usage's ownWording.
  const own: TokenUsageReport = {
    ...report,
    improvements: report.improvements.map((h) => (h.nativeRow ? { ...h, change: 'native /usage row', patch: 'the change the row describes' } : h)),
  };
  enforceClaims(formatTokenUsage(own), { labels: costLabels(undefined, readBilling(deps.fs, repoRoot)), report: false });
  return { report, json: values.json === true };
}

export const usage: Handler = (args, io, deps) =>
  guarded(io, () => {
    const { report, json } = usageReport(args, deps);
    if (json) io.out(JSON.stringify(report, null, 2));
    else formatTokenUsage(report).forEach((l) => io.out(l));
    return EXIT.ok;
  });
