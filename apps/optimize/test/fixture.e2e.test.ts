// E2E of `fixture add | list | remove` with the built binary (R0-05): a temp git repo, a clean HOME, the E2E PATH of
// only node and git. The binary pins a fixture; a later commit breaks the success command; a clean checkout of the
// pinned commit still replays it with the same exit code and the same prompt hash. Identities and dirty trees are
// refused. (`compare --plan-only` also replays the pinned commit since: compare.e2e.test.ts.)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentHash, validateRecord, type FixtureV1 } from '@crafthall/optimize-engine';
import { BUNDLE, e2ePath, runCli } from './e2e-path';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-fx-home-');
const repo = tmp('optimize-fx-repo-');
const worktree = join(tmp('optimize-fx-wt-'), 'checkout');
afterAll(() => [home, repo, dirname(worktree)].forEach((d) => rmSync(d, { recursive: true, force: true })));

const env = { HOME: home, USERPROFILE: home, PATH: e2ePath(), NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'bot@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'bot@fixture.invalid' } }).trim();
const runBin = (...args: string[]) => runCli(args, { cwd: repo, timeout: 30_000, env });
const runCheck = (cwd: string, check: string) => spawnSync(check, { cwd, shell: true, encoding: 'utf8', timeout: 30_000, env }).status;

const CHECK = 'node check.mjs';
const PROMPT = 'Change nothing; the value file must stay 42 and the check must pass.\n';

// Seed: a repo whose success command passes at the first commit.
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Zelda Quist');
git(repo, 'config', 'user.email', 'zelda@example.org');
writeFileSync(join(repo, 'check.mjs'), "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('value.txt', 'utf8').trim() === '42' ? 0 : 1);\n");
writeFileSync(join(repo, 'value.txt'), '42\n');
writeFileSync(join(repo, 'task.md'), PROMPT);
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'seed');
git(repo, 'checkout', '-q', '-b', 'feature/acme-ticket-42');
const pinned = git(repo, 'rev-parse', 'HEAD');
const baselineExit = runCheck(repo, CHECK);

describe('fixture add / list / remove with the built binary', () => {
  let fixture: FixtureV1;

  it('the success command passes at the commit to be pinned (baseline)', () => {
    expect(existsSync(BUNDLE)).toBe(true);
    expect(baselineExit).toBe(0);
  });

  it('fixture add pins HEAD; first line is the verdict; the record is schema-valid and private', () => {
    const r = runBin('fixture', 'add', 'keep-42', '--prompt', 'task.md', '--check', CHECK, '--timeout-min', '5');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe(`fixture "keep-42" added: commit ${pinned.slice(0, 12)}, prompt stored as a salted hash only`);
    const text = readFileSync(join(repo, '.crafthall/optimize/fixtures/keep-42.json'), 'utf8');
    fixture = JSON.parse(text) as FixtureV1;
    expect(validateRecord(fixture)).toEqual([]);
    expect(fixture).toMatchObject({ name: 'keep-42', commit: pinned, promptFile: 'task.md', check: CHECK, caps: { timeoutMin: 5, maxBudgetUsd: 0.5 } });
    expect(fixture.oracleTools.map((t) => t.name)).toEqual(['node']);
    for (const banned of [PROMPT.trim(), repo, home, 'Zelda', 'zelda@example.org', 'acme-ticket-42']) expect(text).not.toContain(banned);
    expect(r.stdout).not.toContain(repo);
  });

  it('refuses a check that names the branch (exit 2), an unknown commit (exit 2) and a dirty tree (exit 3)', () => {
    const ident = runBin('fixture', 'add', 'leaky', '--prompt', 'task.md', '--check', `${CHECK} # acme-ticket-42`);
    expect(ident.status).toBe(2);
    expect(ident.stderr).toContain('/check (identity)');
    expect(runBin('fixture', 'add', 'ghost', '--prompt', 'task.md', '--check', CHECK, '--commit', '0'.repeat(40)).status).toBe(2);
    writeFileSync(join(repo, 'value.txt'), '41\n');
    const dirty = runBin('fixture', 'add', 'dirty', '--prompt', 'task.md', '--check', CHECK);
    expect(dirty.status).toBe(3);
    expect(dirty.stderr.split('\n')[0]).toMatch(/^refused: /);
    expect(readdirSync(join(repo, '.crafthall/optimize/fixtures'))).toEqual(['keep-42.json']);
  });

  it('a later commit breaks the check at HEAD, the store stays out of git', () => {
    git(repo, 'commit', '-q', '-am', 'break the value');
    expect(runCheck(repo, CHECK)).toBe(1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('fixture list shows the fixture; --json gives the same schema-valid record', () => {
    const r = runBin('fixture', 'list');
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('1 fixture');
    expect(r.stdout).toContain(pinned.slice(0, 12));
    const j = runBin('fixture', 'list', '--json');
    expect(JSON.parse(j.stdout)).toEqual([fixture]);
  });

  it('replay: a clean checkout of the pinned commit runs the success command with the baseline exit and the same prompt hash', () => {
    git(repo, 'worktree', 'add', '-q', '--detach', worktree, fixture.commit);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(runCheck(worktree, fixture.check)).toBe(baselineExit);
    const salt = readFileSync(join(repo, '.crafthall/optimize/salt'), 'utf8').trim();
    expect(contentHash(readFileSync(join(worktree, fixture.promptFile!), 'utf8'), salt)).toBe(fixture.promptHash);
    git(repo, 'worktree', 'remove', '--force', worktree);
  });

  it('fixture remove deletes it; removing again is a usage error; HOME stays empty', () => {
    expect(runBin('fixture', 'remove', 'keep-42')).toMatchObject({ status: 0, stdout: 'fixture "keep-42" removed\n' });
    expect(runBin('fixture', 'remove', 'keep-42').status).toBe(2);
    expect(runBin('fixture', 'list').stdout.split('\n')[0]).toMatch(/^no fixtures yet/);
    expect(readdirSync(home)).toEqual([]);
  });
});
