// Plugin E2E (R1-02): the built plugin folder and its five slash commands against a seeded repository, with a
// stubbed `claude` first on PATH (test/e2e-path.ts; the real `claude` is never run). Each command's `!`-line is run
// as Claude Code runs it before the command text reaches the model (https://code.claude.com/docs/en/slash-commands,
// "The !`command` syntax"): `${CLAUDE_PLUGIN_ROOT}` = the built plugin folder, `$ARGUMENTS` = the typed arguments,
// through /bin/sh. Checks:
//   - plugin/ holds a byte copy of the CLI bundle, LICENSE, README, notices and the generated plugin.json;
//   - every command prints the CLI's verdict or summary line first (the same first line as the CLI run directly) and
//     ends with its exit code line; stderr notes come after stdout;
//   - a plugin-started `compare` stops at the plan even when the user typed --yes: no `claude -p` run, no record; only
//     compare.md's confirm command (`--plugin --confirmed`) runs the comparison, and its first line is the verdict.
// Claude Code itself (loading the plugin, the model following the text) is not exercised here: that needs a real
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BIN_NAME } from '../src/brand';
import { PLUGIN_BUNDLE_PATH, pluginManifestText } from '../src/plugin-manifest';
import { BUNDLE, e2ePath, runCli, runShell, writeStubClaude } from './e2e-path';
import { PLUGIN_DIR, readCommand, substitute, type PluginCommand } from './plugin-commands';

const APP = join(import.meta.dirname, '..');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-plugin-home-');
const repo = tmp('optimize-plugin-repo-');
const stubDir = tmp('optimize-plugin-stub-');
const LOG = join(stubDir, 'calls.jsonl');
afterAll(() => [home, repo, stubDir].forEach((d) => rmSync(d, { recursive: true, force: true })));

// The stub `claude` of compare.e2e.test.ts: --version prints a version; a run logs its argv and prints a recorded
// result (cost 0.40 baseline, 0.20 when the patched CLAUDE.md says "terse").
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
const changed = fs.readFileSync('CLAUDE.md', 'utf8').includes('terse');
fs.appendFileSync(log, JSON.stringify({ args }) + '\\n');
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
const calls = (): unknown[] => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const records = (): string[] => {
  const dir = join(repo, '.crafthall/optimize/records');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'bot@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'bot@fixture.invalid' } }).trim();

// The seeded repository: a task, its success command, a CLAUDE.md and a patch that makes it terse.
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'check.mjs'), "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('value.txt', 'utf8').trim() === '42' ? 0 : 1);\n");
writeFileSync(join(repo, 'value.txt'), '42\n');
writeFileSync(join(repo, 'task.md'), 'Keep value.txt at 42 and make the check pass.\n');
writeFileSync(join(repo, 'CLAUDE.md'), 'Explain every step in long prose.\n');
git('add', '.');
git('commit', '-q', '-m', 'seed');
writeFileSync(join(repo, 'CLAUDE.md'), 'Be terse.\n');
const PATCH = join(stubDir, 'change.patch'); // outside the repo, so the working tree stays clean
writeFileSync(PATCH, `${git('diff')}\n`);
git('checkout', '-q', '--', 'CLAUDE.md');
// Session records of this repository for `usage` (the engine's fixture sessions), and saved /usage rows.
const FIXTURES = join(APP, '..', '..', 'libs', 'optimize-engine', 'tests', 'fixtures', 'sessions');
const projects = join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(projects, { recursive: true });
copyFileSync(join(FIXTURES, 'v2.1.326.jsonl'), join(projects, '7f1c2a9e-0000-4000-8000-000000000001.jsonl'));
const ROWS = join(stubDir, 'usage-rows.txt');
writeFileSync(ROWS, '25%  Trim CLAUDE.md · 49k tokens per request\n40%  Switch from max to high effort · /effort high\n');

/** Runs a slash command's !-line with the typed arguments, as Claude Code does. */
const slash = (name: PluginCommand, args: string, input?: string) => {
  const [line] = readCommand(name).bang;
  return runShell(substitute(line!, PLUGIN_DIR, args), { cwd: repo, env, input });
};
const lines = (s: string) => s.split('\n').filter((l) => l !== '');
const first = (s: string) => lines(s)[0];
const exitLine = (code: number) => `${BIN_NAME} exit code: ${code}`;
/** The CLI run directly (no plugin mode), for the reference first line. */
const direct = (...args: string[]) => runCli(args, { cwd: repo, env });

describe('the built plugin folder', () => {
  it('holds a byte copy of the CLI bundle, the app’s LICENSE, README and notices, and the generated manifest', () => {
    expect(readFileSync(join(PLUGIN_DIR, PLUGIN_BUNDLE_PATH)).equals(readFileSync(BUNDLE))).toBe(true);
    for (const f of ['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md']) expect(readFileSync(join(PLUGIN_DIR, f), 'utf8'), f).toBe(readFileSync(join(APP, f), 'utf8'));
    expect(readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(pluginManifestText());
  });
});

describe('each slash command against a seeded repository prints the verdict line first', () => {
  it('fixture-add: the CLI’s summary line first, exit code 0, the fixture stored', () => {
    const r = slash('fixture-add', 'keep-42 --prompt task.md --check "node check.mjs"');
    expect(r.status).toBe(0);
    const out = lines(r.stdout);
    expect(out[0]).toMatch(/keep-42/);
    expect(out.at(-1)).toBe(exitLine(0));
    expect(existsSync(join(repo, '.crafthall/optimize/fixtures/keep-42.json'))).toBe(true);
    expect(direct('fixture', 'list').stdout).toContain('keep-42');
  });

  it('usage: the same first line as the CLI (the token totals), exit code 0', () => {
    const ref = direct('usage', '--days', '3650');
    expect(ref.status, ref.stderr).toBe(0);
    const r = slash('usage', '--days 3650');
    expect(first(r.stdout)).toBe(first(ref.stdout));
    expect(first(r.stdout)).toMatch(/tokens in the last 3650 days/);
    expect(lines(r.stdout).at(-1)).toBe(exitLine(0));
  });

  it('import-usage: the same first line as the CLI from the saved /usage rows, exit code 0', () => {
    const ref = direct('import-usage', '--usage-file', ROWS);
    expect(ref.status, ref.stderr).toBe(0);
    const r = slash('import-usage', `--usage-file ${ROWS}`);
    expect(first(r.stdout)).toBe(first(ref.stdout));
    expect(lines(r.stdout).at(-1)).toBe(exitLine(0));
  });

  it('import-usage never reads stdin in plugin mode: rows piped in are ignored (as if none were given)', () => {
    const rows = readFileSync(ROWS, 'utf8');
    const withRows = runCli(['import-usage'], { cwd: repo, env, input: rows });
    const withoutRows = runCli(['import-usage'], { cwd: repo, env, input: '' });
    expect(withRows.status, withRows.stderr).toBe(0);
    expect(withRows.stdout).not.toBe(withoutRows.stdout); // positive control: the CLI reads piped rows
    const r = slash('import-usage', '', rows);
    expect(lines(r.stdout).slice(0, -1)).toEqual(lines(withoutRows.stdout + withoutRows.stderr));
    expect(lines(r.stdout).at(-1)).toBe(exitLine(0));
  });

  it('compare: stops at the plan even with a typed --yes – plan line first, no claude run, no record, notes after stdout', () => {
    const ref = direct('compare', '--change', PATCH, '--monthly-volume', '1000', '--plan-only');
    expect(ref.status, ref.stderr).toBe(0);
    const r = slash('compare', `--change ${PATCH} --monthly-volume 1000 --yes`);
    const out = lines(r.stdout);
    expect(out[0]).toBe(first(ref.stdout));
    expect(out[0]).toMatch(/^Plan: 8 runs/);
    expect(r.stdout).toContain('Plan only: nothing was run and nothing was spent.');
    expect(out.at(-1)).toBe(exitLine(0));
    // The billing hint is a stderr line: held until stdout is written (verdict first).
    const hint = out.findIndex((l) => l.startsWith('Billing mode not set'));
    expect(hint).toBeGreaterThan(out.indexOf('Plan only: nothing was run and nothing was spent.'));
    expect(calls()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it('compare: even --yes, --plan-only=false and --force typed together do not start a run', () => {
    const r = slash('compare', `--change ${PATCH} --monthly-volume 1000 --yes --force --plan-only=false`);
    expect(r.stdout).toContain('Plan only: nothing was run and nothing was spent.');
    expect(calls()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it('compare: only the confirm command of compare.md runs it; its first line is the verdict, as `report` prints it', () => {
    const [confirm] = readCommand('compare').bashBlocks;
    const line = substitute(confirm!, PLUGIN_DIR, '').replace('<the same arguments>', `--change ${PATCH} --monthly-volume 1000`);
    const r = runShell(line, { cwd: repo, env });
    const out = lines(r.stdout);
    expect(out.at(-1), r.stdout).toBe(exitLine(0));
    expect(calls()).toHaveLength(8);
    expect(records()).toHaveLength(1);
    const id = records()[0]!.replace(/\.json$/, '');
    const ref = direct('report', id);
    expect(ref.status, ref.stderr).toBe(0);
    expect(out[0]).toBe(first(ref.stdout));
    // The plan block (stderr in a spending run) comes after the verdict and the report.
    expect(out.findIndex((l) => l.startsWith('Plan: 8 runs'))).toBeGreaterThan(0);
  });

  it('report: the same first line as the CLI (the verdict), exit code 0; --redact too', () => {
    const id = records()[0]!.replace(/\.json$/, '');
    const ref = direct('report', id);
    const r = slash('report', id);
    expect(first(r.stdout)).toBe(first(ref.stdout));
    expect(lines(r.stdout).at(-1)).toBe(exitLine(0));
    const red = slash('report', `${id} --redact`);
    expect(first(red.stdout)).toBe(first(direct('report', id, '--redact').stdout));
    expect(red.stdout).not.toContain(id);
  });

  it('a usage error still ends with the exit code line, so the !-line never aborts the command', () => {
    const r = slash('report', 'no-such-record.json');
    expect(r.status).toBe(0);
    expect(first(r.stdout)).toMatch(/record file not found/);
    expect(lines(r.stdout).at(-1)).toBe(exitLine(2));
  });
});
