// E2E of the token-use verdict (R1-19) with the built binary and a stubbed `claude` (never the real one):
// the changed arm (CLAUDE.md says "terse") halves token use at the same cost, so a token verdict finds a saving and a
// cost verdict does not. Subscription billing → `tokens` by default (token wording, no currency in the token result);
// API billing → `cost` by default; `--metric cost` overrides; an invalid `--metric` is a usage error (exit 2).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateRecord, type ComparisonRecordV1 } from '@crafthall/optimize-engine';
import { e2ePath, runCli, writeStubClaude } from './e2e-path';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-metric-home-');
const repo = tmp('optimize-metric-repo-');
const stubDir = tmp('optimize-metric-stub-');
const LOG = join(stubDir, 'calls.jsonl');
afterAll(() => [home, repo, stubDir].forEach((d) => rmSync(d, { recursive: true, force: true })));

// Same cost in both arms (jittered); the changed arm uses half the tokens, spread over two models.
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
fs.appendFileSync(log, '{}\\n');
const changed = fs.readFileSync('CLAUDE.md', 'utf8').includes('terse');
const j = 1 + 0.04 * ((n % 5) - 2);
const cost = 0.4 * (1 + 0.05 * (((n * 7) % 5) - 2));
const k = (changed ? 0.5 : 1) * j;
const main = { inputTokens: Math.round(1000 * k), cacheCreationInputTokens: Math.round(3000 * k), cacheReadInputTokens: Math.round(40000 * k), outputTokens: Math.round(900 * k), costUSD: cost * 0.9 };
const side = { inputTokens: Math.round(200 * k), cacheCreationInputTokens: 0, cacheReadInputTokens: Math.round(1000 * k), outputTokens: Math.round(50 * k), costUSD: cost * 0.1 };
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 15000, total_cost_usd: cost,
  result: 'answer text', usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 },
  modelUsage: { 'claude-opus-5-5': main, 'claude-haiku-4-5': side } }));
`,
);

const env = {
  HOME: home,
  USERPROFILE: home,
  PATH: e2ePath(join(stubDir, 'bin')),
  NO_COLOR: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  STUB_LOG: LOG,
  ANTHROPIC_API_KEY: 'sk-ant-api03-e2eFixedTestValueNotARealKey000000000000',
};
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'bot@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'bot@fixture.invalid' } }).trim();
const runBin = (...args: string[]) => runCli(args, { cwd: repo, env });
const records = (): ComparisonRecordV1[] => {
  const dir = join(repo, '.crafthall/optimize/records');
  return existsSync(dir) ? readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};
const latest = (before: number): ComparisonRecordV1 => {
  const all = records();
  expect(all.length).toBe(before + 1);
  const ids = new Set(all.slice(0, before).map((r) => r.id));
  return all.find((r) => !ids.has(r.id))!;
};

git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'check.mjs'), 'process.exit(0);\n');
writeFileSync(join(repo, 'task.md'), 'Do the task.\n');
writeFileSync(join(repo, 'CLAUDE.md'), 'Explain every step in long prose.\n');
git('add', '.');
git('commit', '-q', '-m', 'seed');
writeFileSync(join(repo, 'CLAUDE.md'), 'Be terse.\n');
writeFileSync(join(repo, 'change.patch'), `${git('diff')}\n`);
git('checkout', '-q', '--', 'CLAUDE.md');

const COMPARE = ['compare', '--change', 'change.patch', '--runs-per-arm', '5', '--monthly-volume', '1000', '--yes'];
const CURRENCY = /(?:\b(?:USD|EUR|CHF|GBP)\s?\d|[$€£]\s?\d)/;

describe('compare --metric with the built binary', () => {
  it('setup: fixture add', () => {
    const r = runBin('fixture', 'add', 'task-a', '--prompt', 'task.md', '--check', 'node check.mjs');
    expect(r.status, r.stderr).toBe(0);
  });

  it('an invalid --metric is a usage error (exit 2) before any run', () => {
    const r = runBin(...COMPARE, '--metric', 'dollars');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--metric must be one of tokens, cost');
    expect(records()).toHaveLength(0);
  });

  it('subscription billing → token verdict by default: token wording in plan and report, no currency in the token result', () => {
    expect(runBin('config', 'set', 'billing', 'subscription').status).toBe(0);
    const plan = runBin('compare', '--change', 'change.patch', '--runs-per-arm', '5', '--plan-only');
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toMatch(/planned MDE: +\d+\.\d% saving in token use detectable at n = 5 per arm \(CV 0\.30 of token use per run, assumed – no pilot/);
    expect(plan.stdout).toContain("token use – raw count of input, cache write (5m + 1h), cache read and output tokens, summed over every model of the run; cache reads count at full weight (how your plan's limit weighs token kinds is not published");

    const r = runBin(...COMPARE);
    expect(r.status, r.stderr).toBe(0);
    const rec = latest(0);
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.schemaVersion).toBe('1.5.0');
    expect(rec.metric).toBe('tokens');
    expect(rec.runs[0]!.metrics.modelUsageTokens).toBeDefined();
    expect(rec.verdict.code).toBe('measured-saving');
    expect(rec.result.costRatio!).toBeGreaterThan(0.45);
    expect(rec.result.costRatio!).toBeLessThan(0.55);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toMatch(/^Measured saving of \d+% in token use: token ratio 0\.\d{3} \(95% CI 0\.\d{3}–0\.\d{3}\), measured on 10 runs of your fixtures\.$/);
    expect(lines[0]).toBe(rec.verdict.text);
    expect(r.stdout).toMatch(/token ratio: +0\.\d{3} changed ÷ baseline, 95% CI/);
    for (const part of ['input', 'cache write', 'cache read', 'output']) expect(r.stdout).toMatch(new RegExp(`  ${part}: +0\\.\\d{3} changed ÷ baseline – descriptive only, no interval, no verdict`));
    expect(r.stdout).not.toContain('cost ratio');
    for (const l of lines.filter((l) => /token ratio|in token use|changed ÷ baseline/.test(l))) expect(l).not.toMatch(CURRENCY);
    expect(r.stdout).toContain('On a Pro, Max or Ultra plan a saving is plan capacity, not money');

    const again = runBin('report', rec.id);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toBe(r.stdout);
  });

  it('subscription billing with --metric cost → cost verdict (the same cost in both arms: not enough evidence)', () => {
    const r = runBin(...COMPARE, '--metric', 'cost');
    expect(r.status, r.stderr).toBe(0);
    const rec = latest(1);
    expect(rec.metric).toBe('cost');
    expect(rec.verdict.code).toBe('not-enough-evidence');
    expect(r.stdout.split('\n')[0]).toMatch(/^Not enough evidence.*cost ratio /);
    expect(r.stdout).not.toContain('token ratio');
  });

  it('api billing → cost verdict by default', () => {
    expect(runBin('config', 'set', 'billing', 'api').status).toBe(0);
    const r = runBin(...COMPARE);
    expect(r.status, r.stderr).toBe(0);
    const rec = latest(2);
    expect(validateRecord(rec)).toEqual([]);
    expect(rec.metric).toBe('cost');
    expect(rec.verdict.code).toBe('not-enough-evidence');
    expect(r.stdout).toMatch(/cost ratio: +\d\.\d{3} changed ÷ baseline/);
    expect(r.stdout).not.toContain('token ratio');
    expect(r.stderr).toMatch(/planned MDE: +\d+\.\d% saving detectable/);
  });

  it('api billing with --metric tokens → token verdict', () => {
    const r = runBin(...COMPARE, '--metric', 'tokens');
    expect(r.status, r.stderr).toBe(0);
    const rec = latest(3);
    expect(rec.metric).toBe('tokens');
    expect(rec.verdict.code).toBe('measured-saving');
    expect(r.stdout.split('\n')[0]).toMatch(/^Measured saving of \d+% in token use: token ratio/);
  });
});
