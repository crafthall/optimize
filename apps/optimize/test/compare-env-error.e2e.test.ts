// E2E of with the built binary, a stubbed `claude` (never the real one) and a stub `git` first on PATH that
// wraps the real git and sleeps past a short, test-only git time limit at one chosen call. The limit comes in through
// a preload (`node --import`) that sets the node-port options main.ts reads – no environment variable a user could set.
// (1) `git worktree add` times out at run 3: exit 4, the cause named ("git timed out … (machine busy?)", not "install
// git"), a schema-valid incomplete record of runs 0-2, no run directory left in the temp folder, no worktree left.
// (2) one `git worktree remove` times out: it is retried once, the comparison completes (exit 0), the temp folder is clean.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { validateRecord, type ComparisonRecordV1 } from '@crafthall/optimize-engine';
import { e2ePath, runCli, writeStubClaude } from './e2e-path';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-enverr-home-');
const repo = tmp('optimize-enverr-repo-');
const stubDir = tmp('optimize-enverr-stub-');
/** The CLI's own temp folder (TMPDIR), so the test can see every run directory it leaves behind. */
const runTmp = tmp('optimize-enverr-tmp-');
const gitState = join(stubDir, 'git-state');
afterAll(() => [home, repo, stubDir, runTmp].forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * Test-only git limit. Long enough that an ordinary git call on a heavily loaded machine stays under it (the T1 run
 * hit 15 s at load ~314; real default 120 s), short enough to keep the test fast: the stub sleeps 120 s, killed here.
 */
const GIT_LIMIT_MS = 10_000;
const PRELOAD = join(stubDir, 'git-limit.mjs');
writeFileSync(PRELOAD, `globalThis[Symbol.for('crafthall-optimize.test.node-deps-options')] = { gitTimeoutMs: ${GIT_LIMIT_MS} };\n`);

const REAL_GIT = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
const bin = join(stubDir, 'bin');
mkdirSync(bin);
mkdirSync(gitState);
// Counts `worktree add` / `worktree remove` calls (0-based); at the configured one it sleeps instead of running git.
writeFileSync(
  join(bin, 'git'),
  `#!/bin/sh
if [ "$1" = worktree ] && { [ "$2" = add ] || [ "$2" = remove ]; }; then
  f="$STUB_GIT_STATE/$2"
  n=$(cat "$f" 2>/dev/null || echo 0)
  echo $((n + 1)) > "$f"
  if [ "$2" = add ] && [ "$n" = "\${STUB_GIT_SLOW_ADD:-x}" ]; then exec sleep 120; fi
  if [ "$2" = remove ] && [ "$n" = "\${STUB_GIT_SLOW_REMOVE:-x}" ]; then exec sleep 120; fi
fi
exec "$STUB_REAL_GIT" "$@"
`,
);
chmodSync(join(bin, 'git'), 0o755);
writeStubClaude(
  bin,
  `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
fs.readFileSync(0, 'utf8');
const cost = 0.3 + Math.random() * 0.02;
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 15000, total_cost_usd: cost,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 900 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 900, costUSD: cost } } }));
`,
);

const env = {
  HOME: home,
  USERPROFILE: home,
  PATH: e2ePath(bin),
  TMPDIR: runTmp,
  NO_COLOR: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  STUB_GIT_STATE: gitState,
  STUB_REAL_GIT: REAL_GIT,
  ANTHROPIC_API_KEY: 'sk-ant-api03-e2eFixedTestValueNotARealKey000000000000',
};
const git = (...args: string[]) =>
  execFileSync(REAL_GIT, args, { cwd: repo, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'bot@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'bot@fixture.invalid' } }).trim();
const records = (): ComparisonRecordV1[] => {
  const dir = join(repo, '.crafthall/optimize/records');
  return existsSync(dir) ? readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};
const runDirsLeft = () => readdirSync(runTmp).filter((f) => f.startsWith('crafthall-optimize-run-'));

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Zelda Quist');
git('config', 'user.email', 'zelda@example.org');
writeFileSync(join(repo, 'CLAUDE.md'), 'Be thorough.\n');
writeFileSync(join(repo, 'check.mjs'), 'process.exit(0);\n');
writeFileSync(join(repo, 'task.md'), 'Make the check pass.\n');
git('add', '.');
git('commit', '-q', '-m', 'seed');
writeFileSync(join(repo, 'CLAUDE.md'), 'Be terse.\n');
writeFileSync(join(repo, 'change.patch'), `${git('diff')}\n`);
git('checkout', '-q', '--', 'CLAUDE.md');

const GO = ['compare', '--change', 'change.patch', '--monthly-volume', '1000', '--yes'];
const opts = (extra: Record<string, string>) => ({ cwd: repo, env: { ...env, ...extra }, nodeArgs: ['--import', pathToFileURL(PRELOAD).href], timeout: 300_000 });

describe('compare: an environment error mid-comparison keeps the completed runs (#1137, built binary)', () => {
  beforeEach(() => {
    rmSync(gitState, { recursive: true, force: true });
    mkdirSync(gitState);
  });

  it('fixture add pins the task', () => {
    const r = runCli(['fixture', 'add', 'pass', '--prompt', 'task.md', '--check', 'node check.mjs'], { cwd: repo, env });
    expect(r.status, r.stderr).toBe(0);
  });

  it('git worktree add timing out at run 3: exit 4, cause named, a valid incomplete record of runs 0-2, temp folder clean', () => {
    // Add 0 is the patch check before any run, so run 3 is add 4.
    const r = runCli(GO, opts({ STUB_GIT_SLOW_ADD: '4' }));
    expect(r.status, r.stderr).toBe(4);
    expect(r.stderr).toContain(`git timed out after ${GIT_LIMIT_MS / 1000} s (machine busy?)`);
    expect(r.stderr).not.toContain('install git');
    const recs = records();
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.status).toBe('incomplete');
    expect(rec.runs.map((x) => x.seq)).toEqual([0, 1, 2]);
    expect(r.stderr).toContain(`3 runs completed, recorded in .crafthall/optimize/records/${rec.id}.json (incomplete)`);
    expect(runDirsLeft()).toEqual([]);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
  }, 300_000);

  it('one git worktree remove timing out is retried: the comparison completes (exit 0), temp folder clean', () => {
    const before = records().length;
    const r = runCli(GO, opts({ STUB_GIT_SLOW_REMOVE: '2' }));
    expect(r.status, r.stderr).toBe(0);
    const recs = records();
    expect(recs).toHaveLength(before + 1);
    expect(recs.at(-1)!.status).toBe('complete');
    expect(runDirsLeft()).toEqual([]);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  }, 300_000);
});
