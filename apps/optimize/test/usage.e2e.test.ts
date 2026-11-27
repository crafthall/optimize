// E2E of `usage` (R1-20) with the built binary in a temporary git repository and a clean HOME whose
// ~/.claude/projects/ holds this repo's project folder (the fixture sessions of Claude Code 2.1.321 / 2.1.326 / 2.1.330,
// one of them as a subagent file) and another project's folder. A preload logs every path the CLI touches: the CLI
// reads this repo's folder (positive control) and nothing else under HOME, writes nothing, and prints totals and at
// least one fix with a `compare --plan-only` command; `--json` validates against its schema.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenUsageSchemaV1, validateAgainst } from '@crafthall/optimize-engine';
import { e2ePath, runCli } from './e2e-path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimize-usage-')));
const home = join(root, 'home');
const repo = join(root, 'my.repo');
const tools = join(root, 'tools');
const projects = join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
const other = join(home, '.claude', 'projects', '-elsewhere-other-repo');
const SPY = join(tools, 'fs-spy.mjs');
const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'libs', 'optimize-engine', 'tests', 'fixtures', 'sessions');
const UUID = '0b6f2c1e-6a4d-4c3e-9f1a-2d3e4f5a6b7c';

const spySource = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const append = fs.appendFileSync.bind(fs);
const log = process.env.FS_SPY_LOG;
let busy = false;
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'opendirSync', 'realpathSync', 'createReadStream', 'writeFileSync', 'mkdirSync']) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function (p, ...rest) {
    if (!busy && (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p))) {
      busy = true; // appendFileSync calls writeFileSync: do not log the log
      try { append(log, name + ' ' + String(p) + '\\n'); } finally { busy = false; }
    }
    return orig.call(this, p, ...rest);
  };
}
syncBuiltinESMExports();
`;

const runBin = (args: string[], log: string) =>
  runCli(args, {
    cwd: repo,
    timeout: 30_000,
    nodeArgs: ['--import', pathToFileURL(SPY).href],
    env: { HOME: home, USERPROFILE: home, PATH: e2ePath(), NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', FS_SPY_LOG: log },
  });
const touched = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const listAll = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();

beforeAll(() => {
  mkdirSync(tools);
  writeFileSync(SPY, spySource);
  mkdirSync(join(projects, UUID, 'subagents'), { recursive: true });
  copyFileSync(join(FIXTURES, 'v2.1.326.jsonl'), join(projects, `${UUID}.jsonl`));
  copyFileSync(join(FIXTURES, 'v2.1.330.jsonl'), join(projects, UUID, 'subagents', 'agent-a1.jsonl'));
  copyFileSync(join(FIXTURES, 'v2.1.321.jsonl'), join(projects, 'zelda-notes.jsonl'));
  mkdirSync(other, { recursive: true });
  copyFileSync(join(FIXTURES, 'v2.1.321.jsonl'), join(other, 'x.jsonl'));
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

describe('crafthall-optimize usage (built binary)', () => {
  it('default source → totals, splits, D1–D6, a fix with compare --plan-only; reads only this repo’s folder under HOME; writes nothing', () => {
    const before = { home: listAll(home), repo: listAll(repo) };
    const log = join(tools, 'run-1.log');
    const r = runBin(['usage', '--days', '3650'], log);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out.split('\n')[0]).toBe('1,009,320 tokens in the last 3650 days: 2 sessions, 24 requests (counted from your session records; the shares behind the checks and the fixes are estimated, not measured)');
    expect(out).toMatch(/^ {2}cache read\s+630,000\s+62\.4%$/m);
    expect(out).toMatch(/^ {2}claude-opus-5-5\s+1,009,320\s+100\.0%\s+24 requests$/m);
    expect(out).toMatch(/^ {2}subagents\s+336,440\s+33\.3%\s+8 requests$/m);
    expect(out).toContain(`1. ${UUID}  672,880 tokens (66.7%)`);
    for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) expect(out).toMatch(new RegExp(`^ {2}${id} .+: about [\\d,]+ tokens \\(`, 'm'));
    expect(out).toContain('evidence: same line in 2 places: CLAUDE.md:3, .claude/rules/tests.md:1');
    expect(out).toMatch(/^ {5}try: crafthall-optimize compare --change optimize-[\w-]+\.patch --plan-only$/m);
    for (const bad of [home, repo, 'zelda', 'Zelda', 'FIXTURE', 'sk-ant-', 'acme-ticket', 'E2E Tester', 'e2e@example.org']) expect(out).not.toContain(bad);

    const paths = touched(log).map((l) => l.slice(l.indexOf(' ') + 1));
    expect(paths.some((p) => p.startsWith(`${projects}/`))).toBe(true); // positive control
    expect(paths.filter((p) => p.startsWith(home) && !p.startsWith(projects))).toEqual([]);
    expect(touched(log).filter((l) => /^(?:writeFileSync|mkdirSync) /.test(l))).toEqual([]);
    expect({ home: listAll(home), repo: listAll(repo) }).toEqual(before);
  });

  it('--json validates against tokenUsageSchemaV1 (kind crafthall-optimize/token-usage, format 1)', () => {
    const r = runBin(['usage', '--days', '3650', '--json'], join(tools, 'run-2.log'));
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(validateAgainst(tokenUsageSchemaV1, json)).toEqual([]);
    expect(Object.keys(json).sort()).toEqual(['byDay', 'byModel', 'byRole', 'checks', 'improvements', 'inputs', 'kind', 'label', 'summary', 'topSessions', 'totals', 'window'].concat(['format']).sort()) // pinned shape;
    expect(json).toMatchObject({ kind: 'crafthall-optimize/token-usage', format: 1, totals: { total: 1_009_320 }, inputs: { source: 'project-folder', sessionFiles: 2, subagentFiles: 1 } });
    expect(json.improvements.length).toBeGreaterThan(0);
  });

  it('--read-transcripts reads the given folder; a bad --days exits 2', () => {
    const r = runBin(['usage', '--read-transcripts', other, '--days', '3650', '--json'], join(tools, 'run-3.log'));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ totals: { total: 336_440 }, inputs: { source: 'read-transcripts' } });
    expect(runBin(['usage', '--days', '0'], join(tools, 'run-4.log')).status).toBe(2);
  });
});
