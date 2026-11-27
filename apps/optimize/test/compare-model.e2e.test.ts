// E2E of with the built binary and a stubbed `claude` (never the real one): (1) a model change as the change
// under test – the patch switches `.claude/settings.json` `model` from Opus to Sonnet (T1's change C-a) and the stub
// answers with the model its worktree is configured with, so the arms run on different models and nothing is excluded;
// (2) Ctrl-C mid-run – the stub sleeps in its third run and the test sends SIGINT to the CLI's process group, as a
// terminal does: exit 5, every run worktree removed, the repo clean, a schema-valid incomplete record of the runs done;
// (3): SIGTERM or SIGINT sent to the CLI process alone (`kill <pid>`) stops it as promptly, with the same result.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MODEL_CHANGE_NOTE, validateRecord, type ComparisonRecordV1 } from '@crafthall/optimize-engine';
import { e2ePath, runCli, spawnCli, writeStubClaude } from './e2e-path';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-model-home-');
const repo = tmp('optimize-model-repo-');
const stubDir = tmp('optimize-model-stub-');
const LOG = join(stubDir, 'calls.jsonl');
const SLEEPING = join(stubDir, 'sleeping');
afterAll(() => [home, repo, stubDir].forEach((d) => rmSync(d, { recursive: true, force: true })));

mkdirSync(join(stubDir, 'bin'));
writeStubClaude(
  join(stubDir, 'bin'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
fs.readFileSync(0, 'utf8');
const log = process.env.STUB_LOG;
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
const model = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8')).model;
fs.appendFileSync(log, JSON.stringify({ cwd: process.cwd(), model }) + '\\n');
if (process.env.STUB_SLEEP_AT !== undefined && Number(process.env.STUB_SLEEP_AT) === n) {
  fs.writeFileSync(process.env.STUB_SLEEPING, String(n));
  setTimeout(() => process.exit(0), 60000);
  return;
}
const cost = (model === 'claude-sonnet-5-5' ? 0.24 : 0.4) * (1 + 0.04 * ((n % 5) - 2));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 15000, total_cost_usd: cost,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 900 },
  modelUsage: { [model]: { inputTokens: 1200, outputTokens: 900, costUSD: cost } } }));
`,
);

const env = {
  HOME: home,
  USERPROFILE: home,
  PATH: e2ePath(join(stubDir, 'bin')),
  NO_COLOR: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  STUB_LOG: LOG,
  STUB_SLEEPING: SLEEPING,
  ANTHROPIC_API_KEY: 'sk-ant-api03-e2eFixedTestValueNotARealKey000000000000',
};
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'bot@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'bot@fixture.invalid' } }).trim();
const calls = (): { cwd: string; model: string }[] => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const records = (): ComparisonRecordV1[] => {
  const dir = join(repo, '.crafthall/optimize/records');
  return existsSync(dir) ? readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Zelda Quist');
git('config', 'user.email', 'zelda@example.org');
mkdirSync(join(repo, '.claude'));
writeFileSync(join(repo, '.claude/settings.json'), '{ "model": "claude-opus-5-5" }\n');
writeFileSync(join(repo, 'check.mjs'), 'process.exit(0);\n');
writeFileSync(join(repo, 'task.md'), 'Make the check pass.\n');
git('add', '.');
git('commit', '-q', '-m', 'seed');
writeFileSync(join(repo, '.claude/settings.json'), '{ "model": "claude-sonnet-5-5" }\n');
writeFileSync(join(repo, 'change.patch'), `${git('diff')}\n`);
git('checkout', '-q', '--', '.claude/settings.json');

const GO = ['compare', '--change', 'change.patch', '--monthly-volume', '1000', '--yes'];

describe('compare: model per arm and Ctrl-C with the built binary (#1130)', () => {
  it('fixture add pins the task', () => {
    const r = runCli(['fixture', 'add', 'pass', '--prompt', 'task.md', '--check', 'node check.mjs'], { cwd: repo, env });
    expect(r.status, r.stderr).toBe(0);
  });

  it('a model change (Opus → Sonnet via .claude/settings.json) is measured: nothing excluded, both models stored and shown', () => {
    const r = runCli(GO, { cwd: repo, env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('model per arm:    baseline claude-opus-5-5, changed claude-sonnet-5-5');
    expect(new Set(calls().map((c) => c.model))).toEqual(new Set(['claude-opus-5-5', 'claude-sonnet-5-5']));
    const [rec] = records();
    expect(validateRecord(rec)).toEqual([]);
    expect(rec!.status).toBe('complete');
    expect(rec!.exclusions).toEqual([]);
    expect(rec!.versions.modelByArm).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' });
    expect(rec!.result.costRatio).toBeLessThan(1);
    expect(r.stdout).toContain('model baseline claude-opus-5-5, changed claude-sonnet-5-5');
  });

  it('SIGINT to the process group mid-run: exit 5, worktrees gone, repo clean, a valid incomplete record of the runs done', async () => {
    rmSync(LOG, { force: true });
    const before = records().length;
    const child = spawnCli(GO, { cwd: repo, env: { ...env, STUB_SLEEP_AT: '2' } });
    let stderr = '';
    child.stderr!.on('data', (b: Buffer) => (stderr += b.toString()));
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    const deadline = Date.now() + 60_000;
    while (!existsSync(SLEEPING) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(SLEEPING), 'the stub reached its sleeping run').toBe(true);
    process.kill(-child.pid!, 'SIGINT');
    expect(await exited, stderr).toBe(5);
    expect(stderr).toContain('stopped: interrupted (SIGINT)');
    // Every run worktree is gone: none listed by git, none of the run directories left on disk.
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    for (const c of calls()) expect(existsSync(c.cwd), c.cwd).toBe(false);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
    const recs = records();
    expect(recs).toHaveLength(before + 1);
    const rec = recs.find((x) => x.status === 'incomplete')!;
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.runs.map((x) => x.seq)).toEqual([0, 1]);
    expect(rec.stop).toBe('interrupted');
    expect(calls()).toHaveLength(3);
  }, 90_000);

  // item 4: a run that hits its own time limit is killed by the runner with SIGTERM – that is a `timeout`
  // exclusion, never the user's interrupt. The fixture's limit is 0.25 min (15 s); the stub sleeps 60 s in run 3 (seq 2).
  // At a machine load of ~600 another stub run can pass the limit too – that is also a timeout, so only seq 2 is pinned.
  it('a claude run killed by its own timeout is excluded as a timeout, not treated as Ctrl-C: exit 0, complete record', () => {
    const add = runCli(['fixture', 'add', 'slow', '--prompt', 'task.md', '--check', 'node check.mjs', '--timeout-min', '0.25'], { cwd: repo, env });
    expect(add.status, add.stderr).toBe(0);
    rmSync(LOG, { force: true });
    const before = records().length;
    const r = runCli([...GO, '--fixtures', 'slow'], { cwd: repo, env: { ...env, STUB_SLEEP_AT: '2' }, timeout: 170_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('interrupted');
    const recs = records();
    expect(recs).toHaveLength(before + 1);
    const rec = recs.at(-1)!;
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.status).toBe('complete');
    expect(rec.stop).toBeUndefined();
    expect(rec.exclusions).toContainEqual({ seq: 2, reason: 'timeout' });
    expect(rec.exclusions.every((x) => x.reason === 'timeout')).toBe(true);
    expect(calls()).toHaveLength(8);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    expect(runCli(['fixture', 'remove', 'slow'], { cwd: repo, env }).status).toBe(0);
  }, 180_000);

  //: a signal sent to the CLI process alone (`kill <pid>`, not the process group) was held until the synchronous
  // run loop ended – here, until the stub's 60 s sleep ran out. The async run loop ends the running child at once.
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    it(`${signal} to the CLI process only stops the comparison promptly: exit 5, worktrees gone, a valid incomplete record (stop "interrupted")`, async () => {
      rmSync(LOG, { force: true });
      rmSync(SLEEPING, { force: true });
      const before = records().length;
      const child = spawnCli(GO, { cwd: repo, env: { ...env, STUB_SLEEP_AT: '2' } });
      let stderr = '';
      let stdout = '';
      child.stderr!.on('data', (b: Buffer) => (stderr += b.toString()));
      child.stdout!.on('data', (b: Buffer) => (stdout += b.toString()));
      const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
      const deadline = Date.now() + 60_000;
      while (!existsSync(SLEEPING) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(SLEEPING), 'the stub reached its sleeping run').toBe(true);
      const sent = Date.now();
      process.kill(child.pid!, signal);
      expect(await exited, stderr).toBe(5);
      // Well under the stub's 60 s sleep: the CLI ended the child instead of waiting for it.
      expect(Date.now() - sent).toBeLessThan(30_000);
      expect(stderr).toContain(`stopped: interrupted (${signal})`);
      expect(git('worktree', 'list').split('\n')).toHaveLength(1);
      for (const c of calls()) expect(existsSync(c.cwd), c.cwd).toBe(false);
      expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
      const recs = records();
      expect(recs).toHaveLength(before + 1);
      const rec = recs.at(-1)!;
      expect(validateRecord(rec)).toEqual([]);
      expect(rec.status).toBe('incomplete');
      expect(rec.stop).toBe('interrupted');
      expect(rec.verdict.code).not.toBe('measured-saving');
      expect(rec.runs.map((x) => x.seq)).toEqual([0, 1]);
      expect(stdout.split('\n')[0]).toBe(rec.verdict.text);
      expect(calls()).toHaveLength(3);
    }, 90_000);
  // L6 (legal note §8.8): on subscription billing a model change claims no plan-capacity saving. Last in the block: it
  // stores billing = subscription, which the tests above run without.
  it('a model change on subscription billing: saving stored as an API-equivalent estimate and the sentence printed', () => {
    expect(runCli(['config', 'set', 'billing', 'subscription'], { cwd: repo, env }).status).toBe(0);
    rmSync(LOG, { force: true });
    const before = records().length;
    const r = runCli(GO, { cwd: repo, env });
    expect(r.status, r.stderr).toBe(0);
    const recs = records();
    expect(recs).toHaveLength(before + 1);
    const rec = recs.at(-1)!;
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.versions.modelByArm).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' });
    expect(rec.labels).toMatchObject({ billing: 'subscription', saving: 'api-equivalent-estimate' });
    expect(r.stdout).toContain(`saving counts as: API-equivalent estimate: ${MODEL_CHANGE_NOTE}`);
    expect(MODEL_CHANGE_NOTE).toBe('Anthropic does not publish how plan limits weight models, so no plan-capacity saving is claimed.');
    const rep = runCli(['report', rec.id], { cwd: repo, env });
    expect(rep.status, rep.stderr).toBe(0);
    expect(rep.stdout).toContain(MODEL_CHANGE_NOTE);
    const json = runCli(['report', rec.id, '--json'], { cwd: repo, env });
    expect(JSON.parse(json.stdout).labels.saving).toBe('api-equivalent-estimate');
  }, 120_000);
});
