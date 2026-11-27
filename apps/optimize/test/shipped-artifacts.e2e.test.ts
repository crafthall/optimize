// R1-06: the static scan of shipped-scan.ts over every file of the packed npm tarball – no paid surface, no
// telemetry, no network code, only the allowed child processes and documentation links. Runs in `optimize:verify`
// (e2e target, after the build) and fails on any match. R1-02: every file of the built plugin folder
// (apps/optimize/plugin: manifest, commands, the bundle copy, LICENSE, README, notices) is scanned the same way.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN_NAME } from '../src/brand';
import { e2ePath } from './e2e-path';
import { packTarball, readTree, type Packed } from './pack';
import { PLUGIN_BUNDLE_PATH, PLUGIN_COMMANDS } from '../src/plugin-manifest';
import { PLUGIN_DIR } from './plugin-commands';
import { scanShipped, spawnSites, type ShippedFile } from './shipped-scan';

let packed: Packed;
let files: ShippedFile[];
beforeAll(() => {
  e2ePath(); // the PATH check of also guards the npm run inside packTarball
  packed = packTarball();
  files = readTree(packed.unpacked);
});
afterAll(() => packed?.cleanup());

describe('shipped artifacts have no paid or network surface (npm tarball)', () => {
  it('scans every file of the tarball, the bundle included', () => {
    expect(files.map((f) => f.path)).toEqual(packed.files);
    expect(files.find((f) => f.path === `dist/${BIN_NAME}.mjs`)!.text.length).toBeGreaterThan(50_000);
  });

  it('no finding in any shipped file', () => {
    expect(scanShipped(files)).toEqual([]);
  });

  it('the child processes are exactly git, the user’s claude, the success command and its tools’ --version', () => {
    const bundle = files.find((f) => f.path === `dist/${BIN_NAME}.mjs`)!.text;
    expect(spawnSites(bundle).sort()).toEqual(['runChild(bin)', 'runChild(command)', 'spawn(file)', 'spawnSync("git")', 'spawnSync(bin)', 'spawnSync(tool)']);
    expect(bundle).toMatch(/const bin = options\d*\.claudeBin \?\? "claude";/);
  });
});

describe('shipped artifacts have no paid or network surface (Claude Code plugin folder)', () => {
  const plugin = readTree(PLUGIN_DIR);

  it('scans every file of the plugin, the bundle, manifest and commands included', () => {
    expect(plugin.map((f) => f.path)).toEqual(
      ['.claude-plugin/plugin.json', 'LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md', ...PLUGIN_COMMANDS.map((c) => `commands/${c}.md`), PLUGIN_BUNDLE_PATH].sort(),
    );
    expect(plugin.find((f) => f.path === PLUGIN_BUNDLE_PATH)!.text.length).toBeGreaterThan(50_000);
  });

  it('no finding in any plugin file', () => {
    expect(scanShipped(plugin)).toEqual([]);
  });

  it('the plugin bundle starts the same child processes as the npm bundle', () => {
    const bundle = plugin.find((f) => f.path === PLUGIN_BUNDLE_PATH)!.text;
    expect(spawnSites(bundle).sort()).toEqual(['runChild(bin)', 'runChild(command)', 'spawn(file)', 'spawnSync("git")', 'spawnSync(bin)', 'spawnSync(tool)']);
  });

  it('the scan is not vacuous on the plugin: a planted paid phrase in a command file is found', () => {
    const planted = plugin.map((f) => (f.path === 'commands/compare.md' ? { ...f, text: `${f.text}\nUpgrade to Pro for unlimited runs.\n` } : f));
    expect(scanShipped(planted)).toEqual([{ file: 'commands/compare.md', rule: 'upgrade', match: 'Upgrade to' }]);
  });
});
