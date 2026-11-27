// E2E of R0-13 (legal note §3 item 3) with the built binary: a seeded repo with a hook in .claude/settings.json
// and an MCP server in .mcp.json, a clean HOME and a stub `claude` first on PATH that logs its argv (the real `claude`
// is never called). `fixture add` lists both; `compare --auth subscription` exits 3 with no run unless
// --trust-fixture-config; the default api-key mode passes --bare on every call.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { e2ePath, runCli, writeStubClaude } from './e2e-path';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const home = tmp('optimize-fc-home-');
const repo = tmp('optimize-fc-repo-');
const stubDir = tmp('optimize-fc-stub-');
const LOG = join(stubDir, 'calls.jsonl');
afterAll(() => [home, repo, stubDir].forEach((d) => rmSync(d, { recursive: true, force: true })));

mkdirSync(join(stubDir, 'bin'));
writeStubClaude(
  join(stubDir, 'bin'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args }) + '\\n');
const changed = fs.readFileSync('CLAUDE.md', 'utf8').includes('terse');
const cost = changed ? 0.2 : 0.4;
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 1000, total_cost_usd: cost, result: 'ok',
  usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 10, costUSD: cost } } }));
`,
);

const env: Record<string, string> = {
  HOME: home,
  USERPROFILE: home,
  PATH: e2ePath(join(stubDir, 'bin')),
  NO_COLOR: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  STUB_LOG: LOG,
  ANTHROPIC_API_KEY: 'sk-ant-api03-e2eFixedTestValueNotARealKey000000000000',
};
const noKey = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'ANTHROPIC_API_KEY'));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'bot@fixture.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'bot@fixture.invalid' } }).trim();
const runBin = (e: Record<string, string>, ...args: string[]) => runCli(args, { cwd: repo, env: e });
const calls = (): { args: string[] }[] => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

git('init', '-q', '-b', 'main');
mkdirSync(join(repo, '.claude'));
writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node .claude/fmt.js' }] }] } }, null, 2));
writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'issue-tracker': { command: 'node', args: ['mcp.js'] } } }, null, 2));
writeFileSync(join(repo, 'task.md'), 'Make the check pass.\n');
writeFileSync(join(repo, 'CLAUDE.md'), 'Explain every step.\n');
git('add', '.');
git('commit', '-q', '-m', 'seed');
writeFileSync(join(repo, 'CLAUDE.md'), 'Be terse.\n');
writeFileSync(join(repo, 'change.patch'), `${git('diff')}\n`);
git('checkout', '-q', '--', 'CLAUDE.md');

const COMPARE = ['compare', '--change', 'change.patch', '--runs-per-arm', '1', '--monthly-volume', '1000', '--force', '--yes'];

describe('untrusted fixture config with the built binary (R0-13)', () => {
  it('fixture add lists the hook and the MCP server in a security note and still adds the fixture', () => {
    const r = runBin(env, 'fixture', 'add', 'seeded', '--prompt', 'task.md', '--check', 'node --version');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')[0]).toMatch(/^fixture "seeded" added/);
    expect(r.stderr).toContain('Security note');
    expect(r.stderr).toContain('hook PostToolUse ×1 (.claude/settings.json)');
    expect(r.stderr).toContain('MCP server issue-tracker (.mcp.json)');
  });

  it('compare --auth subscription exits 3 before any run without --trust-fixture-config', () => {
    const r = runBin(noKey, ...COMPARE, '--auth', 'subscription');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('refused: this fixture repository configures hooks or MCP servers');
    expect(r.stderr).toContain('fixture "seeded": hook PostToolUse ×1 (.claude/settings.json); MCP server issue-tracker (.mcp.json)');
    expect(calls()).toEqual([]);
  });

  it('api-key mode (default) runs with --bare on every call (stub argv)', () => {
    const r = runBin(env, ...COMPARE);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('--auth api-key runs use --bare, which does not start them. --bare is not a sandbox');
    const c = calls();
    expect(c).toHaveLength(2);
    for (const x of c) expect(x.args[0]).toBe('--bare');
  });

  it('subscription mode with ANTHROPIC_API_KEY set exits 3 before any run, even with --trust-fixture-config (stub: zero calls)', () => {
    const before = calls().length;
    const r = runBin(env, ...COMPARE, '--auth', 'subscription', '--trust-fixture-config');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY is set in your environment. A `claude -p` run always uses that key when it is set, so these runs would be billed to that key's API account");
    expect(r.stderr).toContain('Refused: unset the key or use --auth api-key.');
    expect(r.stderr).not.toContain('Plan:');
    expect(r.stderr).not.toContain('sk-ant-');
    expect(calls().length - before).toBe(0);
  });

  it('--trust-fixture-config lets subscription mode run (no --bare) when no key is set', () => {
    const before = calls().length;
    const r = runBin(noKey, ...COMPARE, '--auth', 'subscription', '--trust-fixture-config');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('ANTHROPIC_API_KEY is set');
    const c = calls().slice(before);
    expect(c).toHaveLength(2);
    for (const x of c) expect(x.args).not.toContain('--bare');
  });
});
