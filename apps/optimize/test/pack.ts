// Packs the npm tarball of the built CLI the way a release would (`npm pack`, R1-04) and unpacks it, for the
// package E2E (package.e2e.test.ts) and the shipped-artifact scan (shipped-artifacts.e2e.test.ts, R1-06).
// npm runs in a clean HOME with its own cache and the shared E2E PATH; nothing touches the network or the registry.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { e2ePath, runNpm } from './e2e-path';

export const APP = join(import.meta.dirname, '..');

/** A clean npm environment: temp HOME, temp cache, offline, no audit, fund or update check. */
export function cleanNpmEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: e2ePath(),
    NO_COLOR: '1',
    npm_config_cache: join(home, '.npm-cache'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

export interface Packed {
  /** Temp folder holding the tarball, the unpacked copy and the clean HOME; remove with cleanup. */
  dir: string;
  tarball: string;
  /** The unpacked `package/` folder. */
  unpacked: string;
  /** Paths inside the tarball as `npm pack --json` lists them, sorted. */
  files: string[];
  home: string;
  cleanup: () => void;
}

/** `npm pack` of apps/optimize into a temp folder, then unpacked with tar. Throws with npm's output on failure. */
export function packTarball(): Packed {
  const dir = mkdtempSync(join(tmpdir(), 'optimize-pack-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const r = runNpm('npm', ['pack', '--json', '--pack-destination', dir], { cwd: APP, env: cleanNpmEnv(home), timeout: 60_000 });
  if (r.status !== 0) throw new Error(`npm pack failed (${r.status}): ${r.stderr}`);
  const [info] = JSON.parse(r.stdout) as { filename: string; files: { path: string }[] }[];
  const tarball = join(dir, info!.filename);
  const unpacked = join(dir, 'unpacked');
  mkdirSync(unpacked);
  const x = spawnSync('/usr/bin/tar', ['-xzf', tarball, '-C', unpacked], { encoding: 'utf8' });
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  return {
    dir,
    tarball,
    unpacked: join(unpacked, 'package'),
    files: info!.files.map((f) => f.path).sort(),
    home,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every file under `root` as [path relative to root, text]. */
export function readTree(root: string): { path: string; text: string }[] {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk(root)
    .sort()
    .map((f) => ({ path: relative(root, f), text: readFileSync(f, 'utf8') }));
}
