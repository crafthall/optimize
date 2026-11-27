// CLI contract end to end (R0-04; release r0 §4) with the built binary in a temp git repo, a clean HOME and a
// stub `claude` first on PATH (recorded `-p` JSON; the real `claude` is never called): one scenario per exit code
// 0–5 (1 via an injected fault: the store path is blocked by a file) and every `--json` output that carries records
// validated against the record schema.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateRecord, type ComparisonRecordV1 } from '@crafthall/optimize-engine';
import { e2ePath, resolveClaude, runCli, writeStubClaude } from './e2e-path';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-ct-home-');
const repo = tmp('optimize-ct-repo-');
const broken = tmp('optimize-ct-broken-');
const stubDir = tmp('optimize-ct-stub-');
afterAll(() => [home, repo, broken, stubDir].forEach((d) => rmSync(d, { recursive: true, force: true })));

mkdirSync(join(stubDir, 'bin'));
writeStubClaude(
  join(stubDir, 'bin'),
  `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
fs.readFileSync(0, 'utf8');
const cost = fs.readFileSync('CLAUDE.md', 'utf8').includes('terse') ? 0.2 : 0.4;
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 1000, total_cost_usd: cost, result: 'ok',
  usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 10, costUSD: cost } } }));
`,
);

// e2ePath without a stub: node and git by symlink, no `claude` at all (the folder of node may hold a real one).
const env: Record<string, string> = { HOME: home, USERPROFILE: home, PATH: e2ePath(join(stubDir, 'bin')), NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', ANTHROPIC_API_KEY: 'sk-ant-api03-e2eFixedTestValueNotARealKey000000000000' };
const gitEnv = { ...env, GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'bot@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'bot@fixture.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const runIn = (cwd: string, e: Record<string, string>, ...args: string[]) => runCli(args, { cwd, env: e });
const runBin = (...args: string[]) => runIn(repo, env, ...args);

for (const dir of [repo, broken]) {
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'task.md'), 'Make the check pass.\n');
  writeFileSync(join(dir, 'CLAUDE.md'), 'Explain every step.\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seed');
}
writeFileSync(join(repo, 'CLAUDE.md'), 'Be terse.\n');
writeFileSync(join(repo, 'change.patch'), `${git(repo, 'diff')}\n`);
git(repo, 'checkout', '-q', '--', 'CLAUDE.md');
// The injected fault: a file where the store directory must go, so creating the store fails with an OS error.
writeFileSync(join(broken, '.crafthall'), 'not a directory\n');

const COMPARE = ['compare', '--change', 'change.patch', '--runs-per-arm', '2', '--monthly-volume', '1000'];

describe('exit codes 0–5 of the built binary (r0 §4)', () => {
  it('0 – command completed: --version, fixture add', () => {
    expect(runBin('--version').status).toBe(0);
    const r = runBin('fixture', 'add', 'task-a', '--prompt', 'task.md', '--check', 'node --version');
    expect(r.status, r.stderr).toBe(0);
  });

  it('1 – internal error (injected fault): one line on stderr, nothing on stdout', () => {
    const r = runIn(broken, env, 'fixture', 'add', 'task-a', '--prompt', 'task.md', '--check', 'node --version');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^crafthall-optimize: internal error: /);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('2 – usage error: unknown flag, missing fixture, invalid patch', () => {
    expect(runBin('compare', '--frob').status).toBe(2);
    expect(runBin(...COMPARE, '--fixtures', 'nope', '--yes').status).toBe(2);
    writeFileSync(join(repo, 'empty.patch'), '\n');
    expect(runBin('compare', '--change', 'empty.patch', '--yes').status).toBe(2);
  });

  it('3 – refused by a guard: no terminal and no --yes; payback over 3 months without --force', () => {
    expect(runBin(...COMPARE).status).toBe(3);
    const r = runBin('compare', '--change', 'change.patch', '--runs-per-arm', '2', '--monthly-volume', '0.01', '--yes');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('to pay back');
  });

  it('4 – environment error: claude not on PATH; api-key mode without a key', () => {
    expect(resolveClaude(e2ePath())).toBeNull();
    const noClaude = runIn(repo, { ...env, PATH: e2ePath() }, ...COMPARE, '--yes');
    expect(noClaude.status).toBe(4);
    expect(noClaude.stderr).toContain('`claude` was not found on PATH');
    const noKey = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'ANTHROPIC_API_KEY'));
    expect(runIn(repo, noKey, ...COMPARE, '--yes').status).toBe(4);
  });

  it('5 – run cap reached: partial record marked incomplete', () => {
    const r = runBin(...COMPARE, '--max-runs', '2', '--force', '--yes', '--json');
    expect(r.status).toBe(5);
    const rec = JSON.parse(r.stdout) as ComparisonRecordV1;
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.status).toBe('incomplete');
  });
});

// r0 §4: `import-usage --json` and `compare --plan-only --json` store nothing and are no records; each has its
// own kind and format, and this pins their top-level shape so a change is a deliberate format bump.
describe('--json non-record outputs: own kind and format, pinned shape', () => {
  it('compare --plan-only --json: { kind: crafthall-optimize/plan, format: 1, plan }, no record', () => {
    const r = runBin(...COMPARE, '--plan-only', '--json');
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['format', 'kind', 'plan']);
    expect(out).toMatchObject({ kind: 'crafthall-optimize/plan', format: 1 });
    expect(Object.keys(out.plan as object).sort()).toEqual(
      ['capped', 'cv', 'cvAssumed', 'expectedCostIsUpperBound', 'expectedCostUsd', 'fullNPerArm', 'intervalPossible', 'mde', 'mdeMeasured', 'nPerArm', 'paybackMonths', 'refusal', 'totalRuns'],
    );
    expect(validateRecord(out)).not.toEqual([]);
  });

  it('import-usage --json: { kind: crafthall-optimize/hypotheses, format: 1, … }, no record', () => {
    const r = runCli(['import-usage', '--json'], { cwd: repo, env, input: '25%  Trim CLAUDE.md · 49k tokens per request\n', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['checks', 'format', 'hypotheses', 'inputs', 'kind', 'mdeAtRunCap', 'summary']);
    expect(out).toMatchObject({ kind: 'crafthall-optimize/hypotheses', format: 1 });
    expect(validateRecord(out)).not.toEqual([]);
  });
});

describe('--json output validated against the record schema', () => {
  let id = '';
  it('compare --json: stdout is one schema-valid comparison record, verdict and human lines on stderr', () => {
    const r = runBin(...COMPARE, '--yes', '--json');
    expect(r.status, r.stderr).toBe(0);
    const rec = JSON.parse(r.stdout) as ComparisonRecordV1;
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.kind).toBe('comparison');
    id = rec.id;
  });

  it('report --json and report --redact --json: schema-valid records', () => {
    for (const extra of [[], ['--redact']]) {
      const r = runBin('report', id, ...extra, '--json');
      expect(r.status, r.stderr).toBe(0);
      expect(validateRecord(JSON.parse(r.stdout))).toEqual([]);
    }
  });

  it('fixture list --json and fixture remove --json: schema-valid fixture records', () => {
    const list = runBin('fixture', 'list', '--json');
    expect(list.status).toBe(0);
    const fixtures = JSON.parse(list.stdout) as unknown[];
    expect(fixtures).toHaveLength(1);
    for (const f of fixtures) expect(validateRecord(f)).toEqual([]);
    const removed = runBin('fixture', 'remove', 'task-a', '--json');
    expect(removed.status).toBe(0);
    expect(validateRecord(JSON.parse(removed.stdout))).toEqual([]);
  });
});
