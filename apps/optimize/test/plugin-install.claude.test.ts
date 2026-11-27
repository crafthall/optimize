/**
 * The Crafthall Optimize plugin installed into a clean, isolated Claude Code, with no model call (R1-02; the
 * is NOT part of `optimize:test`, `optimize:e2e` or `optimize:verify`; run it by hand at the release gate:
 *   1 `claude plugin validate` passes on the built plugin folder
 *   2 a temp local marketplace (`crafthall-local`, source `./plugin` = a copy of the built folder; the shared
 *     marketplace is R1-03) is added and `crafthall-optimize@crafthall-local` installed in an isolated config (HOME and
 *     CLAUDE_CONFIG_DIR in a temp folder): listed, enabled, the five commands and a byte copy of the bundle installed
 *   3 the installed bundle prints the brand version line, and its plugin-mode `compare` stops at the plan
 *   4 uninstall and marketplace remove succeed
 *   5 no model call: no key or token in any `claude` environment, every request goes to a loopback proxy that refuses and
 *     records it (none expected), the user's real Claude config is unchanged
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN_NAME, PLUGIN_ID } from '../src/brand';
import { versionLine } from '../src/cli';
import { PLUGIN_BUNDLE_PATH, PLUGIN_COMMANDS } from '../src/plugin-manifest';
import { PLUGIN_DIR } from './plugin-commands';

const MARKET_NAME = 'crafthall-local';
const INSTALL_ID = `${PLUGIN_ID}@${MARKET_NAME}`;
const NO_CLAUDE = 'npm run test:claude needs the Claude Code CLI: `claude` was not found on PATH. Put it on PATH and run `npm run test:claude` again. This test does not skip.';

function findClaude(path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, 'claude');
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** Hashes of the user's real Claude plugin config – read only, never written. */
function realConfigFingerprint() {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const hash = (p: string) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing');
  const names = (p: string) => (existsSync(p) ? readdirSync(p).sort() : 'missing');
  return {
    dir,
    hashes: [join('plugins', 'installed_plugins.json'), join('plugins', 'known_marketplaces.json')].map((f) => hash(join(dir, f))),
    cache: names(join(dir, 'plugins', 'cache')),
    marketplaces: names(join(dir, 'plugins', 'marketplaces')),
  };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimize-plugin-install-')));
const claudeHome = join(root, 'home');
const market = join(root, 'marketplace');
const repo = join(root, 'repo');
const proxied: string[] = [];
const spawnedEnvs: Record<string, string>[] = [];
let proxy: Server;
let proxyUrl = '';
let claude = '';
let installPath = '';
let realBefore: ReturnType<typeof realConfigFingerprint>;

function claudeEnv(): Record<string, string> {
  const e = {
    PATH: process.env.PATH ?? '',
    HOME: claudeHome,
    CLAUDE_CONFIG_DIR: join(claudeHome, '.claude'),
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  spawnedEnvs.push(e);
  return e;
}

const plugin = (...args: string[]) =>
  new Promise<{ code: number | null; out: string; stdout: string }>((ok) =>
    execFile(claude, ['plugin', ...args], { cwd: claudeHome, env: claudeEnv(), encoding: 'utf8', timeout: 60_000 }, (e, stdout, stderr) =>
      ok({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, out: `${stdout ?? ''}${stderr ?? ''}`, stdout: stdout ?? '' }),
    ),
  );
type Listed = { id: string; enabled: boolean; installPath: string };
const listed = async () => JSON.parse((await plugin('list', '--json')).stdout) as Listed[];

beforeAll(async () => {
  realBefore = realConfigFingerprint();
  claude = findClaude() ?? '';
  if (!claude) throw new Error(NO_CLAUDE);
  if (!existsSync(join(PLUGIN_DIR, PLUGIN_BUNDLE_PATH))) throw new Error('the plugin is not built: run `npm run build`');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  cpSync(PLUGIN_DIR, join(market, 'plugin'), { recursive: true });
  writeFileSync(
    join(market, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({ name: MARKET_NAME, description: 'Temporary local marketplace of the Crafthall Optimize install check. Not published.', owner: { name: 'Crafthall' }, plugins: [{ name: PLUGIN_ID, source: './plugin' }] }, null, 2)}\n`,
  );
  // An empty git repository as the working folder of the installed bundle.
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  proxy = createServer((req, res) => {
    proxied.push(`${req.method} ${req.url}`);
    res.writeHead(502).end();
  });
  proxy.on('connect', (req, socket) => {
    proxied.push(`CONNECT ${req.url}`);
    socket.destroy();
  });
  proxyUrl = await new Promise<string>((ok) => proxy.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(proxy.address() as { port: number }).port}`)));
}, 120_000);

afterAll(async () => {
  if (proxy) await new Promise<void>((ok) => (proxy.closeAllConnections(), proxy.close(() => ok())));
  rmSync(root, { recursive: true, force: true });
});

describe('Crafthall Optimize plugin installed into a clean Claude Code, no model call (R1-02)', () => {
  it('1. claude plugin validate passes on the built plugin folder', async () => {
    const r = await plugin('validate', join(market, 'plugin'));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Validation passed/);
  });

  it(`2. marketplace add and install ${INSTALL_ID}: listed, enabled, commands and bundle installed`, async () => {
    const add = await plugin('marketplace', 'add', market);
    expect(add.code, add.out).toBe(0);
    const install = await plugin('install', INSTALL_ID);
    expect(install.code, install.out).toBe(0);
    const [entry, ...rest] = await listed();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ id: INSTALL_ID, enabled: true });
    installPath = entry!.installPath;
    expect(installPath.startsWith(join(claudeHome, '.claude', 'plugins') + sep)).toBe(true);
    for (const c of PLUGIN_COMMANDS) expect(existsSync(join(installPath, 'commands', `${c}.md`)), c).toBe(true);
    expect(readFileSync(join(installPath, PLUGIN_BUNDLE_PATH)).equals(readFileSync(join(PLUGIN_DIR, PLUGIN_BUNDLE_PATH)))).toBe(true);
  });

  it('3. the installed bundle prints the version line and has the plugin mode', () => {
    const env = { PATH: process.env.PATH ?? '', HOME: claudeHome, NO_COLOR: '1' };
    const v = spawnSync(process.execPath, [join(installPath, PLUGIN_BUNDLE_PATH), '--version'], { env, encoding: 'utf8' });
    expect(v.stdout.trim()).toBe(versionLine());
    const c = spawnSync(process.execPath, [join(installPath, PLUGIN_BUNDLE_PATH), '--plugin', '--confirmed', 'usage'], { cwd: repo, env, encoding: 'utf8' });
    expect(c.status).toBe(2);
    expect(c.stderr).toContain(`${BIN_NAME}: --plugin: --confirmed applies to compare only`);
  });

  it('4. uninstall removes it; the marketplace is removed too', async () => {
    const un = await plugin('uninstall', INSTALL_ID);
    expect(un.code, un.out).toBe(0);
    expect(await listed()).toEqual([]);
    const rm = await plugin('marketplace', 'remove', MARKET_NAME);
    expect(rm.code, rm.out).toBe(0);
  });

  it('5. no model call: no key or token given, no traffic, the real Claude config unchanged', () => {
    expect(spawnedEnvs.length).toBeGreaterThan(4);
    for (const e of spawnedEnvs) expect(Object.keys(e).filter((k) => /ANTHROPIC|API_KEY|TOKEN|AWS_|CLAUDE_CODE_USE/.test(k))).toEqual([]);
    expect(proxied, 'claude made network calls').toEqual([]);
    const after = realConfigFingerprint();
    expect(after.dir).not.toBe(join(claudeHome, '.claude'));
    expect({ hashes: after.hashes, cache: after.cache, marketplaces: after.marketplaces }).toEqual({ hashes: realBefore.hashes, cache: realBefore.cache, marketplaces: realBefore.marketplaces });
  });
});
