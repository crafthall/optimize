// `import-usage` (R0-09; release r0 §4): hypotheses from pasted `/usage` rows (stdin or --usage-file) and the
// non-native checks D2, D3, D5, D6, ranked, each "estimated, not measured" or "estimated, not measurable".
// Reads this repository's Claude Code config files; reads session records ONLY with --read-transcripts <dir> (legal
// note §1 rule 4), and then only usage fields. Stores nothing. The first output line is the verdict-style summary.
import { isAbsolute, resolve } from 'node:path';
import {
  buildHypotheses,
  costLabels,
  enforceClaims,
  ownWording,
  readBilling,
  emptyTranscriptStats,
  formatHypotheses,
  outputLeaks,
  parseUsageText,
  readSessionFields,
  UsageParseError,
  type ConfigFile,
  type ParsedUsage,
  type SessionFields,
  type TranscriptStats,
} from '@crafthall/optimize-engine';
import { BIN_NAME } from './brand';
import type { CliDeps } from './deps';
import { EXIT } from './exit';
import { guarded, parse, repoRootOf, UsageError, type Handler } from './fixture';

/** Config files read from the repository root (repo-relative). Larger files are skipped. */
const ROOT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'package.json', 'pytest.ini', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Collects the Claude Code config of the repository: root files, rules, agents, commands and skills. */
export function collectConfig(deps: CliDeps, repoRoot: string): ConfigFile[] {
  const out: ConfigFile[] = [];
  const add = (rel: string): void => {
    const text = deps.readFile(`${repoRoot}/${rel}`);
    if (text !== undefined && text.length <= MAX_CONFIG_BYTES) out.push({ path: rel, text });
  };
  ROOT_FILES.forEach(add);
  const mdIn = (dir: string, depth: number): void => {
    for (const name of deps.fs.list(`${repoRoot}/${dir}`).sort()) {
      if (name.endsWith('.md')) add(`${dir}/${name}`);
      else if (depth > 0 && !name.startsWith('.')) mdIn(`${dir}/${name}`, depth - 1);
    }
  };
  mdIn('.claude/rules', 1);
  mdIn('.claude/agents', 0);
  mdIn('.claude/commands', 1);
  for (const name of deps.fs.list(`${repoRoot}/.claude/skills`).sort()) if (!name.startsWith('.')) add(`.claude/skills/${name}/SKILL.md`);
  return out;
}

/**
 * Usage fields of the session record files (`*.jsonl`) in the given folder and its `<session>/subagents/` folders.
 * Each file is read and reduced to fields at once, so its text is dropped before the next file is read (memory stays
 * at one file even for months of records).
 */
function readTranscriptFolder(deps: CliDeps, dir: string): { sessions: SessionFields[]; stats: TranscriptStats } {
  const stats = emptyTranscriptStats();
  const sessions: SessionFields[] = [];
  const read = (p: string): void => {
    const t = deps.readFile(p);
    if (t !== undefined) sessions.push(readSessionFields(t, stats));
  };
  for (const name of deps.fs.list(dir).sort()) {
    if (name.endsWith('.jsonl')) read(`${dir}/${name}`);
    else for (const sub of deps.fs.list(`${dir}/${name}/subagents`).sort()) if (sub.endsWith('.jsonl')) read(`${dir}/${name}/subagents/${sub}`);
  }
  stats.sessions = sessions.length;
  return { sessions, stats };
}

export const importUsage: Handler = (args, io, deps) =>
  guarded(io, () => {
    const { values, positionals } = parse(args, {
      'usage-file': { type: 'string' },
      file: { type: 'string' },
      'read-transcripts': { type: 'string' },
      otel: { type: 'string' },
      json: { type: 'boolean' },
    });
    if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}". Paste the /usage rows on stdin or pass --usage-file <file>`);
    if (values.otel !== undefined) throw new UsageError('--otel is not built yet (moved to release 1, #1116); paste the /usage rows or pass --read-transcripts <dir>');
    const repoRoot = repoRootOf(deps);
    const abs = (p: string): string => (isAbsolute(p) ? p : resolve(deps.cwd, p));

    const usageFile = values['usage-file'] ?? values.file;
    let usageText: string;
    if (usageFile !== undefined) {
      const t = deps.readFile(abs(usageFile));
      if (t === undefined) throw new UsageError('the --usage-file was not found or is not a file');
      usageText = t;
    } else usageText = deps.readStdin?.() ?? '';
    let usage: ParsedUsage;
    try {
      usage = parseUsageText(usageText);
    } catch (e) {
      if (e instanceof UsageParseError) throw new UsageError(e.message);
      throw e;
    }

    let transcripts: ReturnType<typeof readTranscriptFolder> | null = null;
    if (values['read-transcripts'] !== undefined) {
      transcripts = readTranscriptFolder(deps, abs(values['read-transcripts']));
      if (!transcripts.sessions.length) throw new UsageError('no session records (*.jsonl) in the folder given to --read-transcripts; pass a folder under ~/.claude/projects/');
    }

    const identities = [...deps.git.identities(repoRoot), ...deps.machineIdentities()];
    const list = buildHypotheses({
      usage: usage.recognized ? usage : null,
      config: collectConfig(deps, repoRoot),
      transcripts,
      identities,
      repoRoot,
      home: deps.homeDir?.() ?? undefined,
      bin: BIN_NAME,
    });
    const leaks = outputLeaks(list, identities);
    if (leaks.length) throw new Error(`privacy guard stopped the output (${leaks.map((l) => `${l.kind} at ${l.path}`).join(', ')})`);
    // Claim rules (labels.ts): every line Optimize writes itself passes enforceClaims (forbidden wording, no
    // unlabelled currency, qualifier 6). Pasted /usage wording is the user's input and is left out of the check.
    enforceClaims(formatHypotheses(ownWording(list)), { labels: costLabels(undefined, readBilling(deps.fs, repoRoot)), report: false });
    if (values.json) io.out(JSON.stringify(list, null, 2));
    else formatHypotheses(list).forEach((l) => io.out(l));
    return EXIT.ok;
  });
