// E2E of the npm package (R1-04): `npm pack` of the built CLI, install of the tarball into an empty folder with a
// clean HOME and an offline npm, then `npx crafthall-optimize --help` / `--version` (and `npx @crafthall/optimize`)
// exit 0. Licence check: the installed tree and every file esbuild bundled are MIT-compatible; `npm ls` shows no
// Crafthall HQ package. Nothing is published and nothing reaches the registry (offline, no network).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@crafthall/optimize-engine';
import { BIN_NAME, DISPLAY_VERSION, NPM_NAME } from '../src/brand';
import { runNpm } from './e2e-path';
import { APP, cleanNpmEnv, packTarball, type Packed } from './pack';

/** SPDX ids accepted as MIT-compatible for bundled or installed code (permissive, no copyleft). */
const MIT_COMPATIBLE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0']);
const HQ = /@crafthall\/hq|crafthall-hq/i;

let packed: Packed;
let project: string;
let env: Record<string, string>;

beforeAll(() => {
  packed = packTarball();
  project = join(packed.dir, 'empty-project');
  mkdirSync(project);
  // Its own package.json, so npm installs here and never walks up to a parent folder's package.json.
  writeFileSync(join(project, 'package.json'), '{ "private": true }\n');
  env = cleanNpmEnv(packed.home);
  const r = runNpm('npm', ['install', '--offline', '--no-audit', '--no-fund', packed.tarball], { cwd: project, env });
  if (r.status !== 0) throw new Error(`npm install of the tarball failed (${r.status}): ${r.stderr}`);
  if (!existsSync(join(project, 'node_modules', NPM_NAME))) throw new Error('npm installed the tarball outside the empty project');
});
afterAll(() => packed?.cleanup());

const npx = (...args: string[]) => runNpm('npx', ['--offline', ...args], { cwd: project, env, timeout: 60_000 });

describe('npm package @crafthall/optimize (packed tarball, clean HOME)', () => {
  it('the tarball holds exactly the bundle, README, LICENSE, notices and package.json', () => {
    expect(packed.files).toEqual(['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md', `dist/${BIN_NAME}.mjs`, 'package.json']);
    const pkg = JSON.parse(readFileSync(join(packed.unpacked, 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: NPM_NAME, version: '0.1.0', license: 'MIT', homepage: 'https://crafthall.dev' });
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(readFileSync(join(packed.unpacked, 'LICENSE'), 'utf8')).toMatch(/^MIT License\n\nCopyright \(c\) 2026 \S/);
  });

  it(`npx ${BIN_NAME} --version exits 0 with the version and beta label`, () => {
    const r = npx(BIN_NAME, '--version');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${BIN_NAME} ${DISPLAY_VERSION} (record schema ${SCHEMA_VERSION})\n`);
  });

  it(`npx ${BIN_NAME} --help exits 0 and lists the commands`, () => {
    const r = npx(BIN_NAME, '--help');
    expect(r.status, r.stderr).toBe(0);
    for (const c of ['fixture add', 'compare', 'import-usage', 'report']) expect(r.stdout).toContain(c);
  });

  it(`npx ${NPM_NAME} --help exits 0 (the package-name form of R1-04)`, () => {
    const r = npx(NPM_NAME, '--help');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Usage: ${BIN_NAME} <command>`);
  });

  it('npm ls: the package has no dependency, and no Crafthall HQ package is installed', () => {
    const r = runNpm('npm', ['ls', '--all', '--json'], { cwd: project, env });
    expect(r.status, r.stderr).toBe(0);
    const tree = JSON.parse(r.stdout) as { dependencies?: Record<string, { dependencies?: object }> };
    expect(Object.keys(tree.dependencies ?? {})).toEqual([NPM_NAME]);
    expect(tree.dependencies![NPM_NAME]!.dependencies ?? {}).toEqual({});
    expect(r.stdout).not.toMatch(HQ);
  });

  it('licence check: every installed package is MIT-compatible', () => {
    const nm = join(project, 'node_modules');
    const dirs = readdirSync(nm)
      .filter((n) => !n.startsWith('.'))
      .flatMap((n) => (n.startsWith('@') ? readdirSync(join(nm, n)).map((s) => join(nm, n, s)) : [join(nm, n)]));
    expect(dirs.map((d) => d.slice(nm.length + 1))).toEqual([NPM_NAME]);
    for (const d of dirs) expect(MIT_COMPATIBLE.has(JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).license), d).toBe(true);
  });

  it('licence check: the bundle holds only Crafthall Optimize source (CLI and engine, MIT), no third-party code', () => {
    const inputs = JSON.parse(readFileSync(join(APP, 'dist', 'bundle-inputs.json'), 'utf8')) as string[];
    expect(inputs.length).toBeGreaterThan(10);
    const foreign = inputs.filter((p) => !/^(src\/|\.\.\/\.\.\/libs\/optimize-engine\/src\/)/.test(p));
    // Any input from node_modules must name an MIT-compatible licence; today there is none (THIRD-PARTY-NOTICES.md).
    expect(foreign).toEqual([]);
    expect(inputs.filter((p) => HQ.test(p))).toEqual([]);
    for (const p of ['package.json', '../../libs/optimize-engine/package.json']) expect(JSON.parse(readFileSync(join(APP, p), 'utf8')).license).toBe('MIT');
  });

  it('created nothing in the clean HOME besides npm’s own cache and logs', () => {
    expect(readdirSync(packed.home).filter((n) => !n.startsWith('.npm'))).toEqual([]);
    expect(existsSync(join(packed.home, '.claude'))).toBe(false);
  });
});
