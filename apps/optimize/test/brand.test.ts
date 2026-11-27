// R1-01: every public id comes from src/brand.ts, package.json agrees with it, no other source spells an id,
// and no id contains "claude" or "anthropic" (legal note §3). R1-04: the publish guard holds.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as brand from '../src/brand';
import { helpText, versionLine } from '../src/cli';

const APP = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
/** Source text without comments (line comments, block comments), so a comment may name the product. */
const code = (f: string): string =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('brand module (R1-01)', () => {
  it('holds the ids of the release plan', () => {
    expect(brand.PUBLIC_IDS).toEqual({
      productName: 'Crafthall Optimize',
      pluginId: 'crafthall-optimize',
      commandPrefix: '/crafthall-optimize:',
      npmName: '@crafthall/optimize',
      binName: 'crafthall-optimize',
      version: '0.1.0',
      releaseLabel: 'beta',
    });
    expect(brand.COMMAND_PREFIX).toBe(`/${brand.PLUGIN_ID}:`);
    expect(brand.DISPLAY_VERSION).toBe('0.1.0 beta');
  });

  it('no public id contains "claude" or "anthropic" (case-insensitive)', () => {
    const ids = [...Object.values(brand.PUBLIC_IDS), brand.HOMEPAGE, brand.SUPPORT_URL, pkg.name, ...Object.keys(pkg.bin)];
    expect(ids.filter((v) => /claude|anthropic/i.test(String(v)))).toEqual([]);
    // the check is not vacuous
    expect(['claude-optimize', 'AnthropicX', 'x'].filter((v) => /claude|anthropic/i.test(v))).toHaveLength(2);
  });

  it('package.json is declared from the brand module', () => {
    expect(pkg.name).toBe(brand.NPM_NAME);
    expect(pkg.version).toBe(brand.CLI_VERSION);
    expect(Object.keys(pkg.bin)).toEqual([brand.BIN_NAME]);
    expect(pkg.bin[brand.BIN_NAME]).toBe(`dist/${brand.BIN_NAME}.mjs`);
    expect(pkg.homepage).toBe(brand.HOMEPAGE);
    expect(pkg.bugs).toEqual({ url: brand.SUPPORT_URL });
    expect(pkg.license).toBe('MIT');
  });

  it('the CLI prints the ids from the brand module', () => {
    expect(versionLine().startsWith(`${brand.BIN_NAME} ${brand.DISPLAY_VERSION} `)).toBe(true);
    expect(helpText()).toContain(`${brand.PRODUCT_NAME} – `);
    expect(helpText()).toContain(`Usage: ${brand.BIN_NAME} <command>`);
  });

  it('no other CLI source spells an id in code (comments may name the product)', () => {
    const files = walk(join(APP, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('brand.ts'));
    expect(files.length).toBeGreaterThan(8);
    // Allowed: the JSON format kinds (crafthall-optimize/<kind>, a data contract) and main.ts's test-seam symbol.
    const spelled = files.flatMap((f) =>
      [...code(f).matchAll(/crafthall-optimize(?!\/(plan|hypotheses|token-usage)\b|\.test\.)|@crafthall\/optimize(?!-engine)|Crafthall Optimize|\b0\.1\.0\b/g)].map((m) => `${f.slice(APP.length + 1)}: ${m[0]}`),
    );
    expect(spelled).toEqual([]);
  });

  it('the engine, which cannot import an app, spells the binary only in its format kinds, the usage schema title and the billing hint', () => {
    // brand.ts is the brand module itself (moved to the lib for the website, R1-10), not a copy.
    const files = walk(join(APP, '..', '..', 'libs', 'optimize-engine', 'src')).filter((f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f) && !f.endsWith('brand.ts'));
    const uses = files.flatMap((f) => [...code(f).matchAll(/crafthall-optimize(\/[\w-]+| config set billing| usage --json)?/g)].map((m) => m[0]));
    expect(uses.length).toBeGreaterThan(0);
    // A rename of the binary fails here, so the engine's copies are changed in the same PR.
    for (const u of uses) expect(u.startsWith(`${brand.BIN_NAME}/`) || [`${brand.BIN_NAME} config set billing`, `${brand.BIN_NAME} usage --json`].includes(u), u).toBe(true);
  });

  it('src/brand.ts re-exports @crafthall/optimize-engine/brand and spells no id itself (R1-10)', () => {
    const src = code(join(APP, 'src', 'brand.ts'));
    expect(src).toMatch(/from '@crafthall\/optimize-engine\/brand'/);
    expect(src).not.toMatch(/crafthall-optimize|@crafthall\/optimize(?!-engine)|Crafthall Optimize|\b0\.1\.0\b/);
  });

  it('support is the public issue tracker of the source repository, with no support e-mail (R1-14)', () => {
    expect(brand.SUPPORT_URL).toBe('https://github.com/crafthall/optimize/issues');
    expect(brand.SUPPORT_URL.startsWith(`${brand.REPO_URL}/`)).toBe(true);
    expect(brand.SUPPORT_ADDRESS_STATUS).toBe('confirmed');
    expect(JSON.stringify(pkg)).not.toMatch(/support@/);
  });
});

describe('release 1 channels without npm (owner, chat 2026-11-27)', () => {
  const readme = readFileSync(join(APP, 'README.md'), 'utf8');
  const listing = readFileSync(join(APP, 'listing', 'marketplace.md'), 'utf8');
  const npmInstruction = /\bnpx\b|\bnpm (install|i|exec)\b|npm install -g|@crafthall\/optimize\b/;

  it('the standalone CLI is the bundle, attached to a GitHub Release under its bin file name', () => {
    expect(brand.RELEASE_ASSET).toBe('crafthall-optimize.mjs');
    expect(pkg.bin[brand.BIN_NAME]).toBe(`dist/${brand.RELEASE_ASSET}`);
    expect(brand.RELEASES_URL).toBe(`${brand.REPO_URL}/releases`);
    expect(brand.RELEASE_ASSET_LATEST_URL).toBe('https://github.com/crafthall/optimize/releases/latest/download/crafthall-optimize.mjs');
    expect(brand.releaseAssetUrl('0.1.0')).toBe('https://github.com/crafthall/optimize/releases/download/v0.1.0/crafthall-optimize.mjs');
  });

  it('no install command names npm or npx; npm stays a later channel (private package, guard kept)', () => {
    const commands = Object.values(brand.INSTALL).flat();
    expect(commands.filter((c) => npmInstruction.test(c))).toEqual([]);
    expect(pkg.private).toBe(true);
    // the check is not vacuous
    expect(['npx @crafthall/optimize --help', 'npm install -g x', 'npm test'].filter((c) => npmInstruction.test(c))).toHaveLength(2);
  });

  it('the README and the marketplace listing give no npm install instruction; the README gives the release download', () => {
    expect(readme.match(npmInstruction)).toBeNull();
    expect(listing.match(npmInstruction)).toBeNull();
    expect(readme).toContain(brand.INSTALL.cliDownload);
    expect(readme).toContain(brand.INSTALL.cliHelp);
    for (const c of brand.INSTALL.cliOnPath) expect(readme).toContain(c);
    expect(readme).toContain(brand.INSTALL.fallback[0]);
    expect(readme).toContain(brand.INSTALL.fallback[1]);
  });
});

describe('publish guard (R1-04)', () => {
  const guard = (env: Record<string, string>) =>
    spawnSync(process.execPath, [join(APP, 'scripts', 'publish-guard.mjs')], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });

  it('package.json is private, so npm refuses to publish it, and prepublishOnly runs the guard', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.prepublishOnly).toBe('node scripts/publish-guard.mjs');
  });

  it('the guard fails without the explicit go, and with a go for another version', () => {
    const none = guard({});
    expect(none.status).toBe(1);
    expect(none.stderr).toContain(`refusing to publish ${brand.NPM_NAME}@${brand.CLI_VERSION}`);
    expect(guard({ CRAFTHALL_OPTIMIZE_PUBLISH_GO: `${brand.NPM_NAME}@0.0.1` }).status).toBe(1);
    expect(guard({ CRAFTHALL_OPTIMIZE_PUBLISH_GO: '1' }).status).toBe(1);
  });

  it('the guard passes only with CRAFTHALL_OPTIMIZE_PUBLISH_GO=<name>@<version>', () => {
    expect(guard({ CRAFTHALL_OPTIMIZE_PUBLISH_GO: `${brand.NPM_NAME}@${brand.CLI_VERSION}` }).status).toBe(0);
  });
});
