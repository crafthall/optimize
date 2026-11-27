// `usage` (R1-20) through the router with fake ports: the default folder (the repo path encoded the way Claude
// Code names its project folder), --read-transcripts, --days, --usage-file, --json against its schema, exit codes, and
// that nothing is written and nothing outside the project folder and the repo config is read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenUsageSchemaV1, validateAgainst, type StoreFs } from '@crafthall/optimize-engine';
import { EXIT, run } from '../src/cli';
import type { CliDeps } from '../src/deps';
import { projectFolderName } from '../src/usage';

const REPO = '/home/zelda-quist/work/my.repo';
const HOME = '/home/zelda-quist';
const PROJECTS = `${HOME}/.claude/projects/-home-zelda-quist-work-my-repo`;
const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'libs', 'optimize-engine', 'tests', 'fixtures', 'sessions');
const fixture = (v: string) => readFileSync(join(FIXTURES, `${v}.jsonl`), 'utf8');
const UUID = '0b6f2c1e-6a4d-4c3e-9f1a-2d3e4f5a6b7c';

const fake = (disk: Record<string, string>, stdin: string | null = null) => {
  const reads: string[] = [];
  const writes: string[] = [];
  const files = new Map(Object.entries(disk));
  const fs: StoreFs = {
    readText: (p) => files.get(p),
    writeText: (p) => void writes.push(p),
    mkdirp: (p) => void writes.push(p),
    list: (d) => {
      reads.push(d);
      const names = new Set<string>();
      for (const p of files.keys()) if (p.startsWith(`${d}/`)) names.add(p.slice(d.length + 1).split('/')[0]!);
      return [...names];
    },
    remove: () => false,
  };
  const deps: CliDeps = {
    cwd: REPO,
    fs,
    git: { resolveCommit: () => null, isDirty: () => false, identities: () => ['Zelda Quist', 'zelda@example.org', 'feature/acme-ticket-42'] },
    findRepoRoot: (cwd) => (cwd.startsWith(REPO) ? REPO : null),
    readFile: (p) => {
      reads.push(p);
      return files.get(p);
    },
    now: () => new Date('2026-12-01T00:00:00Z'),
    machineIdentities: () => ['zelda-quist', 'zelda-laptop'],
    toolVersion: () => null,
    randomHex: () => 'ab'.repeat(32),
    runner: { claudeVersion: () => null, claude: () => ({ status: 1, stdout: '', timedOut: false, notFound: true }), check: () => null },
    worktrees: { add: () => '/tmp/wt', apply: () => true, remove: () => undefined },
    hasEnv: () => false,
    confirm: () => null,
    readStdin: () => stdin,
    homeDir: () => HOME,
  };
  return { deps, reads, writes };
};

const call = (deps: CliDeps, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
  return { code, out, err: err.join('\n') };
};

const DISK = {
  [`${PROJECTS}/${UUID}.jsonl`]: fixture('v2.1.326'),
  [`${PROJECTS}/${UUID}/subagents/agent-a1.jsonl`]: fixture('v2.1.330'),
  [`${PROJECTS}/zelda-notes.jsonl`]: fixture('v2.1.321'),
  [`${REPO}/CLAUDE.md`]: '# Project\n\nAlways run the full test suite before you open a pull request in this repository.\n',
  [`${REPO}/.claude/rules/tests.md`]: 'Always run the full test suite before you open a pull request in this repository.\n',
  [`${HOME}/.claude/projects/-home-zelda-quist-work-other/x.jsonl`]: fixture('v2.1.321'),
};

describe('crafthall-optimize usage (fake ports)', () => {
  it('encodes the repo path like Claude Code: every non-alphanumeric character becomes -', () => {
    expect(projectFolderName('/Users/zelda/work/.claude/worktrees/issue-1166')).toBe('-Users-zelda-work--claude-worktrees-issue-1166');
    expect(projectFolderName(REPO)).toBe('-home-zelda-quist-work-my-repo');
  });

  it('default source: this repo’s project folder; totals, subagents, top sessions; nothing written; no other folder read', () => {
    const { deps, reads, writes } = fake(DISK);
    const r = call(deps, 'usage', '--days', '30');
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toBe('1,009,320 tokens in the last 30 days: 2 sessions, 24 requests (counted from your session records; the shares behind the checks and the fixes are estimated, not measured)');
    const text = r.out.join('\n');
    expect(text).toMatch(/^ {2}subagents\s+336,440\s+33\.3%\s+8 requests$/m);
    expect(text).toContain(`1. ${UUID}  672,880 tokens (66.7%), 16 requests, 336,440 in subagents`);
    expect(text).toContain('2. session-1  336,440 tokens (33.3%), 8 requests, 0 in subagents');
    expect(text).not.toContain('zelda-notes');
    expect(text).toContain('evidence: same line in 2 places: CLAUDE.md:3, .claude/rules/tests.md:1');
    expect(text).toMatch(/try: crafthall-optimize compare --change optimize-D6-bash-output-filter\.patch --plan-only/);
    expect(writes).toEqual([]);
    expect(reads.filter((p) => p.startsWith(`${HOME}/`) && !p.startsWith(PROJECTS) && !p.startsWith(`${REPO}/`))).toEqual([]);
    expect(reads.some((p) => p.startsWith(PROJECTS))).toBe(true);
  });

  it('default window is 7 days; --days and --read-transcripts', () => {
    const { deps } = fake(DISK);
    expect(call(deps, 'usage').out[0]).toBe('No requests in the last 7 days in the session records read (24 older, 0 undated); try a larger --days');
    const other = call(deps, 'usage', '--read-transcripts', `${HOME}/.claude/projects/-home-zelda-quist-work-other`, '--days', '7', '--json');
    expect(other.code).toBe(EXIT.ok);
    expect(JSON.parse(other.out.join('\n')).inputs).toMatchObject({ source: 'read-transcripts', requests: 0, requestsOutsideWindow: 8 });
  });

  it('--json validates against tokenUsageSchemaV1 and has no identity, path or text', () => {
    const { deps } = fake(DISK);
    const r = call(deps, 'usage', '--days', '30', '--json');
    expect(r.code).toBe(EXIT.ok);
    const json = JSON.parse(r.out.join('\n'));
    expect(validateAgainst(tokenUsageSchemaV1, json)).toEqual([]);
    expect(json.totals.total).toBe(1_009_320);
    const s = r.out.join('\n');
    for (const bad of ['/home/', 'Zelda', 'zelda', 'FIXTURE', 'sk-ant-', 'acme-ticket']) expect(s).not.toContain(bad);
  });

  it('--usage-file adds the native rows; - reads stdin', () => {
    const { deps } = fake({ ...DISK, [`${REPO}/usage.txt`]: '40%  Switch from max to high effort · /effort high\n' }, '25%  Trim CLAUDE.md · 49k tokens per request\n');
    const file = call(deps, 'usage', '--days', '30', '--usage-file', 'usage.txt');
    expect(file.out.join('\n')).toContain('[native /usage row] Switch from max to high effort · /effort high');
    const stdin = call(deps, 'usage', '--days', '30', '--usage-file', '-');
    expect(stdin.out.join('\n')).toContain('[native /usage row] Trim CLAUDE.md · 49k tokens per request');
  });

  it('usage errors exit 2', () => {
    const { deps } = fake(DISK);
    for (const days of ['0', '-1', '1.5', 'x', '3651']) expect(call(deps, 'usage', '--days', days)).toMatchObject({ code: EXIT.usage });
    expect(call(deps, 'usage', 'extra').code).toBe(EXIT.usage);
    expect(call(deps, 'usage', '--usage-file', 'missing.txt').code).toBe(EXIT.usage);
    const empty = fake({});
    const none = call(empty.deps, 'usage');
    expect(none.code).toBe(EXIT.usage);
    expect(none.err).toContain("no session records for this repository in Claude Code's project folder");
    expect(none.err).not.toContain(HOME);
    expect(call(empty.deps, 'usage', '--read-transcripts', '/nowhere').code).toBe(EXIT.usage);
  });
});
