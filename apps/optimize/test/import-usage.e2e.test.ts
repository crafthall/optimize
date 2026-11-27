// E2E of `import-usage` with the built binary (R0-03 / R0-09) in a temporary git repository and a clean HOME.
// A preload (`node --import`) wraps the node:fs functions and logs every path the CLI touches, so the test can show
// that without --read-transcripts nothing under ~/.claude/projects/ is opened – and, as a positive control, that the
// same spy does see those reads when the flag is given (so the negative result is not vacuous).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2ePath, runCli } from './e2e-path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimize-iu-')));
const home = join(root, 'home');
const repo = join(root, 'repo');
const tools = join(root, 'tools');
const projects = join(home, '.claude', 'projects', '-tmp-repo');
const SPY = join(tools, 'fs-spy.mjs');
const SENTINEL = 'SENTINEL-TRANSCRIPT-TEXT-must-never-be-read';

const spySource = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const append = fs.appendFileSync.bind(fs);
const log = process.env.FS_SPY_LOG;
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'opendirSync', 'realpathSync', 'createReadStream']) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function (p, ...rest) {
    if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) append(log, name + ' ' + String(p) + '\\n');
    return orig.call(this, p, ...rest);
  };
}
syncBuiltinESMExports();
`;

const ROWS = '25%  Trim CLAUDE.md · 49k tokens per request\n40%  Switch from max to high effort · /effort high\n';

const runBin = (args: string[], input: string, log: string) =>
  runCli(args, {
    cwd: repo,
    input,
    timeout: 30_000,
    nodeArgs: ['--import', pathToFileURL(SPY).href],
    env: { HOME: home, USERPROFILE: home, PATH: e2ePath(), NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', FS_SPY_LOG: log },
  });

const touched = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

beforeAll(() => {
  mkdirSync(tools);
  writeFileSync(SPY, spySource);
  mkdirSync(projects, { recursive: true });
  const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 9, min)).toISOString();
  const rec = (id: string, min: number, write: number, read: number) =>
    JSON.stringify({ type: 'assistant', requestId: id, timestamp: at(min), message: { content: [{ type: 'text', text: SENTINEL }], usage: { input_tokens: 5, cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: write } } } });
  writeFileSync(join(projects, 'session-1.jsonl'), [rec('r1', 0, 30000, 0), rec('r2', 20, 30000, 0), rec('r3', 21, 100, 30000)].join('\n'));
  mkdirSync(repo);
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true });
  const dup = 'Always run the full test suite before you open a pull request in this repository.';
  writeFileSync(join(repo, 'CLAUDE.md'), `# Project\n\n${dup}\n`);
  writeFileSync(join(repo, '.claude', 'rules', 'tests.md'), `${dup}\n`);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { HOME: home, PATH: e2ePath(), GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=E2E Tester', '-c', 'user.email=e2e@example.org', 'add', '.');
  git('-c', 'user.name=E2E Tester', '-c', 'user.email=e2e@example.org', 'commit', '-qm', 'seed');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('crafthall-optimize import-usage (built binary)', () => {
  it('pasted rows → ranked hypotheses, verdict-style first line, exit 0; nothing under ~/.claude/projects/ is touched', () => {
    const log = join(tools, 'run-1.log');
    const r = runBin(['import-usage'], ROWS, log);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('3 hypotheses to test with compare (estimated, not measured): 2 from native /usage rows, 1 from non-native checks; 0 estimated, not measurable');
    expect(lines[2]).toBe('1. [native /usage row] Switch from max to high effort · /effort high');
    expect(r.stdout).toContain('[D5, not native] Keep one copy of each duplicated instruction');
    expect(r.stdout).toContain('evidence: same line in 2 places: CLAUDE.md:3, .claude/rules/tests.md:1');
    expect(r.stdout).toContain('session records: not read (opt in with --read-transcripts <dir>)');
    expect(r.stdout).not.toMatch(/\bsaved\b/i);
    const paths = touched(log);
    expect(paths.some((p) => p.endsWith(`${join(repo, 'CLAUDE.md')}`))).toBe(true); // the spy works
    expect(paths.filter((p) => p.includes(join('.claude', 'projects')))).toEqual([]);
  });

  it('positive control: with --read-transcripts the same spy sees the session file, and D2 runs', () => {
    const log = join(tools, 'run-2.log');
    const r = runBin(['import-usage', '--read-transcripts', projects, '--json'], '', log);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.checks[0]).toMatchObject({ id: 'D2', status: 'ran' });
    expect(json.hypotheses.map((h: { id: string }) => h.id)).toContain('D2-ttl-1h');
    expect(r.stdout).not.toContain(SENTINEL);
    expect(r.stdout).not.toContain(root);
    expect(touched(log).some((p) => p.includes(join('.claude', 'projects', '-tmp-repo', 'session-1.jsonl')))).toBe(true);
  });

  it('malformed /usage text → exit 2 with the reason on stderr', () => {
    const r = runBin(['import-usage'], '150%  Trim CLAUDE.md\n', join(tools, 'run-3.log'));
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('a /usage row share must be between 0% and 100%');
  });

  it('stores nothing: no .crafthall folder in the repo, nothing new in HOME', () => {
    expect(existsSync(join(repo, '.crafthall'))).toBe(false);
    expect(readdirSync(home).sort()).toEqual(['.claude']);
    expect(readdirSync(join(home, '.claude'))).toEqual(['projects']);
  });
});
