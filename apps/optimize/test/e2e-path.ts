// The one way an E2E test of the built CLI gets a PATH and spawns the binary. Rule: no test ever runs the
// real `claude` or touches the network. The PATH holds only an optional stub folder, a private folder with symlinks
// to node and git (the folder of node may also hold a real `claude` from a global npm install – the 2026-11-26
// incident) and /usr/bin:/bin. Every PATH is checked before use: `claude` must resolve to a stub written through
// writeStubClaude or to nothing; anything else throws before the CLI starts. The guard test
// (e2e-guard.test.ts) fails when an E2E file builds a PATH or spawns the binary without this module.
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BUNDLE = join(import.meta.dirname, '..', 'dist', 'crafthall-optimize.mjs');

/** System folders allowed on an E2E PATH (shell utilities); checked like everything else. */
const SYSTEM_DIRS = ['/usr/bin', '/bin'];

const toolsDir = mkdtempSync(join(tmpdir(), 'optimize-e2e-tools-'));
symlinkSync(process.execPath, join(toolsDir, 'node'));
symlinkSync(execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim(), join(toolsDir, 'git'));
process.on('exit', () => rmSync(toolsDir, { recursive: true, force: true }));

/** Real paths of the stub `claude` scripts this test file wrote; the only `claude` an E2E PATH may resolve to. */
const stubs = new Set<string>();

/** Writes an executable stub `claude` into `binDir` and registers it as allowed. Returns its path. */
export function writeStubClaude(binDir: string, source: string): string {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'claude');
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  stubs.add(realpathSync(file));
  return file;
}

/** What `claude` resolves to on `path` (POSIX `command -v`), or null when it is not found. */
export function resolveClaude(path: string): string | null {
  const r = spawnSync('/bin/sh', ['-c', 'command -v claude'], { env: { PATH: path }, encoding: 'utf8' });
  const found = r.stdout?.trim() ?? '';
  return r.status === 0 && found !== '' ? found : null;
}

/** Throws unless `claude` on `path` is a registered stub or absent. */
export function assertNoRealClaude(path: string | undefined): void {
  if (!path) throw new Error('E2E env has no PATH; build it with e2ePath()');
  const found = resolveClaude(path);
  if (found === null) return;
  let real = found;
  try {
    real = realpathSync(found);
  } catch {
    // unresolvable: compared as given, so it is rejected below
  }
  if (!stubs.has(real)) throw new Error(`E2E PATH resolves \`claude\` to ${found}, which is no test stub – no test may run the real claude`);
}

/** The E2E PATH: the stub folder first when given, then node and git, then /usr/bin:/bin. Checked before return. */
export function e2ePath(stubBinDir?: string): string {
  const path = [...(stubBinDir ? [stubBinDir] : []), toolsDir, ...SYSTEM_DIRS].join(':');
  assertNoRealClaude(path);
  return path;
}

export interface RunCliOptions {
  cwd: string;
  /** The child's whole environment (never inherited); its PATH must come from e2ePath. */
  env: Record<string, string>;
  timeout?: number;
  input?: string;
  /** node flags before the bundle (e.g. `--import <spy>`). */
  nodeArgs?: string[];
}

/** Runs the built CLI with node after checking the PATH it gets. The only place an E2E spawns the binary. */
export function runCli(args: readonly string[], options: RunCliOptions): SpawnSyncReturns<string> {
  assertNoRealClaude(options.env.PATH);
  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), BUNDLE, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  });
}

/** npm's own entry scripts next to the running node (`<prefix>/lib/node_modules/npm/bin/`), run with node directly so
 * the node folder – which may hold a real `claude` – never goes on a PATH. */
const NPM_BIN = join(process.execPath, '..', '..', 'lib', 'node_modules', 'npm', 'bin');

/**
 * Runs `npm` or `npx` (R1-04 package E2E: `npm pack`, install of the tarball, `npx crafthall-optimize`) after the
 * same PATH check as runCli. The env is the child's whole environment; give it a clean HOME and npm cache.
 */
export function runNpm(tool: 'npm' | 'npx', args: readonly string[], options: RunCliOptions): SpawnSyncReturns<string> {
  assertNoRealClaude(options.env.PATH);
  return spawnSync(process.execPath, [join(NPM_BIN, `${tool}-cli.js`), ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  });
}

/**
 * Starts the built CLI without waiting, in its own process group, after the same PATH check. A test sends
 * `process.kill(-child.pid, 'SIGINT')` to the group, which is what Ctrl-C in a terminal does: the CLI and its running
 * child (the stub `claude`) both get the signal.
 */
export function spawnCli(args: readonly string[], options: Omit<RunCliOptions, 'timeout' | 'input'>): ChildProcess {
  assertNoRealClaude(options.env.PATH);
  return spawn(process.execPath, [...(options.nodeArgs ?? []), BUNDLE, ...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Runs one shell command line with /bin/sh after the same PATH check (R1-02): the plugin E2E runs the
 * `!`-lines and the confirm command of the plugin's slash commands as Claude Code would, with `${CLAUDE_PLUGIN_ROOT}`
 * and `$ARGUMENTS` already substituted. `node` in the line resolves to the private node symlink of e2ePath.
 */
export function runShell(line: string, options: RunCliOptions): SpawnSyncReturns<string> {
  assertNoRealClaude(options.env.PATH);
  return spawnSync('/bin/sh', ['-c', line], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  });
}
