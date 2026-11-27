// E2E of `compare` and `report` with the built binary (R0-06, R0-08, R0-14): a temp git repo, a clean HOME,
// and a stubbed `claude` first on PATH – a small node script that returns recorded `-p` JSON (cost 0.40 baseline,
// 0.20 when the patched CLAUDE.md says "terse") and logs its argv and cwd. The real `claude` is never called.
// Flow: fixture add → compare --plan-only (nothing spent) → compare --yes (both arms, schema-valid record) →
// report (verdict first, ratio, CI, passes, measurement cost) → run cap hit (exit 5) → no terminal, no --yes (exit 3).
// Auth (R0-12): the default api-key mode passes --bare and the stub sees ANTHROPIC_API_KEY present (it logs
// presence only); no key → exit 4 with zero runs; --auth subscription prints the plan-limits notice before the plan
// and drops --bare; generated key values never appear in stdout, stderr or a record (property).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { validateRecord, type ComparisonRecordV1 } from '@crafthall/optimize-engine';
import { e2ePath, runCli, writeStubClaude } from './e2e-path';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-cmp-home-');
const repo = tmp('optimize-cmp-repo-');
const stubDir = tmp('optimize-cmp-stub-');
const LOG = join(stubDir, 'calls.jsonl');
afterAll(() => [home, repo, stubDir].forEach((d) => rmSync(d, { recursive: true, force: true })));

// The stub `claude`: --version prints a version; otherwise it reads the prompt from stdin, logs argv/cwd and prints
// a recorded result object. Costs vary a little per call (deterministic) so the interval has a width.
mkdirSync(join(stubDir, 'bin'));
writeStubClaude(
  join(stubDir, 'bin'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const log = process.env.STUB_LOG;
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
const changed = fs.readFileSync('CLAUDE.md', 'utf8').includes('terse');
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), changed, promptBytes: prompt.length, hasKey: Boolean(process.env.ANTHROPIC_API_KEY) }) + '\\n');
const cost = (changed ? 0.2 : 0.4) * (1 + 0.04 * ((n % 5) - 2));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 15000, total_cost_usd: cost,
  result: 'answer text', session_id: 's-' + n,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 900,
    cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 0 } },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 900, costUSD: cost } } }));
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
const runBinEnv = (e: Record<string, string>, ...args: string[]) => runCli(args, { cwd: repo, env: e });
const runBin = (...args: string[]) => runBinEnv(env, ...args);
const withoutKey = (): Record<string, string> => Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'ANTHROPIC_API_KEY'));
const calls = (): { args: string[]; cwd: string; changed: boolean; promptBytes: number; hasKey: boolean }[] =>
  existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const records = (): ComparisonRecordV1[] => {
  const dir = join(repo, '.crafthall/optimize/records');
  return existsSync(dir) ? readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};

const PROMPT = 'Keep value.txt at 42 and make the check pass.\n';
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Zelda Quist');
git('config', 'user.email', 'zelda@example.org');
writeFileSync(join(repo, 'check.mjs'), "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('value.txt', 'utf8').trim() === '42' ? 0 : 1);\n");
writeFileSync(join(repo, 'value.txt'), '42\n');
writeFileSync(join(repo, 'task.md'), PROMPT);
writeFileSync(join(repo, 'CLAUDE.md'), 'Explain every step in long prose.\n');
git('add', '.');
git('commit', '-q', '-m', 'seed');
writeFileSync(join(repo, 'CLAUDE.md'), 'Be terse.\n');
writeFileSync(join(repo, 'change.patch'), `${git('diff')}\n`);
git('checkout', '-q', '--', 'CLAUDE.md');

describe('compare and report with the built binary and a stubbed claude', () => {
  it('fixture add pins the task', () => {
    const r = runBin('fixture', 'add', 'keep-42', '--prompt', 'task.md', '--check', 'node check.mjs');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('compare --plan-only prints the plan, replays the pinned commit, spends nothing (exit 0)', () => {
    const r = runBin('compare', '--change', 'change.patch', '--plan-only');
    // Billing mode unset and no terminal (R0-10): one hint on stderr, nothing asked or stored.
    expect(r.stderr.trim()).toMatch(/^Billing mode not set: cost figures are labelled "API-equivalent estimate"\. Set it once with `crafthall-optimize config set billing <api\|subscription\|credits>`\.$/);
    expect(existsSync(join(repo, '.crafthall/optimize/config.json'))).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Plan: 8 runs/);
    expect(r.stdout).toMatch(/planned MDE: +\d+\.\d% saving detectable at n = 4 per arm/);
    // Both numbers: t-based (df 6): CI excludes 1.0 at n = 4, CV 0.30 → 50.1%; "measured saving" (CI upper ≤ 0.85) → 57.6%.
    expect(r.stdout).toContain('planned MDE:      50.1% saving detectable at n = 4 per arm (CV 0.30, assumed – no pilot; α 0.05; t-based, ≈ 80% power): the 95% CI excludes 1.0');
    expect(r.stdout).toContain('measured saving:  57.6% saving needed for a "measured saving" verdict (CI upper bound ≤ 0.85) at the same n (t-based, ≈ 80% power)');
    expect(r.stdout).not.toContain('capped n:');
    expect(r.stdout).toContain('expected cost:    at most USD 4.00');
    expect(r.stdout).toContain('nothing was run and nothing was spent');
    expect(calls()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it('compare --plan-only under --max-runs recomputes both MDEs for the runs that fit and says so', () => {
    const r = runBin('compare', '--change', 'change.patch', '--plan-only', '--max-runs', '4');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/planned MDE: +\d+\.\d% saving detectable at n = 2 per arm/);
    expect(r.stdout).toMatch(/measured saving: +\d+\.\d% saving needed for a "measured saving" verdict/);
    expect(r.stdout).toContain('capped n:         both figures use the 2 runs per arm that fit under the run cap; the full plan (n = 4 per arm) would detect 50.1%');
    expect(calls()).toEqual([]);
  });

  it('with no terminal and no --yes it refuses with exit 3 before any run', () => {
    const r = runBin('compare', '--change', 'change.patch', '--monthly-volume', '1000');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('refused: no terminal');
    expect(calls()).toEqual([]);
  });

  let record: ComparisonRecordV1;
  it('compare --yes runs both arms interleaved in fresh worktrees and writes a schema-valid record', () => {
    const r = runBin('compare', '--change', 'change.patch', '--runs-per-arm', '5', '--monthly-volume', '1000', '--yes');
    expect(r.status, r.stderr).toBe(0);
    const c = calls();
    expect(c).toHaveLength(10);
    expect(c.map((x) => (x.changed ? 'B' : 'A')).join('')).toBe('ABABABABAB');
    expect(new Set(c.map((x) => x.cwd)).size).toBe(10);
    for (const x of c) {
      expect(x.cwd).not.toBe(repo);
      expect(x.args).toEqual(['--bare', '-p', '--output-format', 'json', '--max-budget-usd', '0.5']);
      expect(x.hasKey).toBe(true);
      expect(x.promptBytes).toBe(PROMPT.length);
      expect(existsSync(x.cwd)).toBe(false);
    }
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    [record] = records();
    expect(validateRecord(record)).toEqual([]);
    expect(record.status).toBe('complete');
    expect(record.auth).toBe('api-key');
    expect(record.runs).toHaveLength(10);
    expect(record.versions).toMatchObject({ claudeCode: '2.1.0 (Claude Code)', model: 'claude-opus-5-5' });
    expect(record.result.passes).toEqual({ baseline: { passed: 5, total: 5 }, changed: { passed: 5, total: 5 } });
    expect(record.verdict.code).toBe('measured-saving');
    expect(r.stdout.split('\n')[0]).toBe(record.verdict.text);
    const text = JSON.stringify(record);
    for (const banned of [PROMPT.trim(), repo, home, stubDir, tmpdir(), 'Zelda', 'zelda@example.org']) expect(text).not.toContain(banned);
  });

  it('report shows the verdict first, then ratio, 95% CI, pass counts and the measurement cost', () => {
    const r = runBin('report', `.crafthall/optimize/records/${record.id}.json`);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toMatch(/^Measured saving of \d+%: cost ratio 0\.\d{3} \(95% CI 0\.\d{3}–0\.\d{3}\), measured on 10 runs of your fixtures\.$/);
    expect(r.stdout).toMatch(/cost ratio: +0\.\d{3} changed ÷ baseline, 95% CI 0\.\d{3}–0\.\d{3}/);
    expect(r.stdout).toContain('passes:           baseline 5/5, changed 5/5');
    expect(r.stdout).toContain('no drop larger than 60 pp detected on your success commands (5 runs; rule of three)');
    expect(r.stdout).toMatch(/measurement cost: USD 3\.\d\d and 451,000 tokens over 10 runs \(API billing – Claude Code's client-side estimate; your bill may differ\)/);
    expect(r.stdout).toContain('saving counts as: API-equivalent estimate (billing mode not set');
    expect(r.stdout).toContain('Comparisons run on your own Claude account and use your tokens or plan capacity; the expected cost is shown before anything runs.');
    expect(r.stdout).not.toMatch(/you saved|quality unchanged|verified quality|no quality loss|\bsafe\b|\bproves?\b|nothing leaves/i);
  });

  it('report --redact --json is a share-safe copy (R0-03): schema-valid, same verdict, no fixture name, commit or store hash', () => {
    const r = runBin('report', record.id, '--redact', '--json');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('Share-safe copy');
    const red = JSON.parse(r.stdout) as ComparisonRecordV1;
    expect(validateRecord(red)).toEqual([]);
    expect(red.verdict).toEqual(record.verdict);
    for (const banned of ['keep-42', record.fixtures[0]!.commit, record.hashes.diff.slice(-64), record.id, repo, 'Zelda', 'Quist']) expect(r.stdout).not.toContain(banned);
    expect(records().map((x) => x.id)).not.toContain(red.id);
  });

  it('the run cap stops the comparison with exit 5 and an incomplete record', () => {
    const before = calls().length;
    const r = runBin('compare', '--change', 'change.patch', '--monthly-volume', '1000', '--max-runs', '3', '--yes', '--force');
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('run cap (--max-runs 3)');
    expect(calls().length - before).toBe(3);
    const capped = records().find((x) => x.status === 'incomplete')!;
    expect(validateRecord(capped)).toEqual([]);
    expect(capped.runs).toHaveLength(3);
  });

  it('api-key mode without ANTHROPIC_API_KEY exits 4 with a hint and zero stub runs', () => {
    const before = calls().length;
    const recs = records().length;
    const noKey = withoutKey();
    const r = runBinEnv(noKey, 'compare', '--change', 'change.patch', '--monthly-volume', '1000', '--yes');
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY');
    expect(r.stderr).toContain('--auth subscription');
    expect(r.stderr).not.toContain('Plan:');
    expect(calls().length - before).toBe(0);
    expect(records()).toHaveLength(recs);
  });

  it('--auth subscription prints the plan-limits notice before the plan and runs without --bare', () => {
    const before = calls().length;
    const noKey = withoutKey();
    const r = runBinEnv(noKey, 'compare', '--change', 'change.patch', '--runs-per-arm', '1', '--monthly-volume', '1000', '--force', '--auth', 'subscription', '--yes');
    expect(r.status, r.stderr).toBe(0);
    const notice = r.stderr.indexOf("Runs count against your plan's limits; Anthropic's plan limits assume ordinary, individual use.");
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(r.stderr.indexOf('Plan:'));
    const c = calls().slice(before);
    expect(c).toHaveLength(2);
    for (const x of c) {
      expect(x.args).toEqual(['-p', '--output-format', 'json', '--max-budget-usd', '0.5']);
      expect(x.hasKey).toBe(false);
    }
    const rec = records().find((x) => x.auth === 'subscription')!;
    expect(validateRecord(rec)).toEqual([]);
  });

  it('no generated API-key value in the environment appears in stdout, stderr or a stored record (property)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{30,90}$/), fc.constantFrom('api-key', 'subscription'), (body, auth) => {
        const key = `sk-ant-api03-${body}`;
        const r = runBinEnv({ ...env, ANTHROPIC_API_KEY: key }, 'compare', '--change', 'change.patch', '--runs-per-arm', '1', '--monthly-volume', '1000', '--force', '--auth', auth, '--yes', '--json');
        // Subscription mode with the key set refuses before any run (legal review); the key still never shows.
        expect(r.status, r.stderr).toBe(auth === 'subscription' ? 3 : 0);
        expect(r.stdout).not.toContain(key);
        expect(r.stderr).not.toContain(key);
        for (const rec of records()) expect(JSON.stringify(rec)).not.toContain(key);
        expect(readFileSync(LOG, 'utf8')).not.toContain(key);
      }),
      { numRuns: 4 },
    );
  });

  // Cost labels (R0-10, R0-11): api billing vs subscription capacity wording end to end.
  it('config set billing api: compare and report print API billing wording; --json carries the labels', () => {
    expect(runBin('config', 'set', 'billing', 'api').status).toBe(0);
    const r = runBin('compare', '--change', 'change.patch', '--runs-per-arm', '1', '--monthly-volume', '1000', '--force', '--yes');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/expected cost: +at most USD [\d.]+, every run at its --max-budget-usd cap \(API billing – Claude Code's client-side estimate; your bill may differ\)/);
    expect(r.stdout).toContain('saving counts as: API billing: a saving lowers your per-token cost');
    const rec = records().at(-1)!;
    expect(rec.labels).toEqual({ billing: 'api', measurementCost: 'api-billing', saving: 'api-billing' });
    expect(validateRecord(rec)).toEqual([]);
    const json = JSON.parse(runBin('report', rec.id, '--json').stdout) as ComparisonRecordV1;
    expect(json.labels).toEqual(rec.labels);
  });

  it('config set billing subscription + --auth subscription: plan capacity wording, never money saved', () => {
    expect(runBin('config', 'set', 'billing', 'subscription').stdout).toContain('a saving is plan capacity, not money');
    const r = runBinEnv(withoutKey(), 'compare', '--change', 'change.patch', '--runs-per-arm', '1', '--monthly-volume', '1000', '--force', '--auth', 'subscription', '--yes');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('(subscription capacity valued at API list price, not money you pay');
    const rec = records().find((x) => x.labels?.billing === 'subscription')!;
    const rep = runBin('report', rec.id);
    expect(rep.status).toBe(0);
    for (const out of [r.stdout, rep.stdout]) {
      expect(out).toContain('On a Pro, Max or Ultra plan a saving is plan capacity, not money; it does not lower your subscription price.');
      expect(out).toMatch(/measurement cost: USD [\d.]+ .*\(subscription capacity/);
      expect(out).not.toMatch(/you saved|API billing|\bsav(e|ed|ing)s?\b[^\n]*(USD|\$)\s?\d/i);
    }
  });
});
