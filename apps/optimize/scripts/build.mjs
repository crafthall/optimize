#!/usr/bin/env node
// Bundles the Crafthall Optimize CLI into one ESM file with no runtime dependencies: dist/crafthall-optimize.mjs (the
// package's bin). In the bundle: src/ and @crafthall/optimize-engine. esbuild comes from the root toolchain (as for
// dist/bundle-inputs.json lists the files esbuild put in the bundle (not shipped: package.json `files` names the bundle
// only); the licence check of R1-04 (test/package.e2e.test.ts) reads it to prove no third-party code is bundled.
// Claude Code plugin (R1-02): plugin/ gets a byte copy of the bundle (scripts/<bin>.mjs), LICENSE, README.md
// and THIRD-PARTY-NOTICES.md (copies of the app's, git-ignored) and .claude-plugin/plugin.json from
// src/plugin-manifest.ts (committed; test/plugin.test.ts checks it). No network, no Crafthall HQ code.
import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
export const BUNDLE = join(APP, 'dist', 'crafthall-optimize.mjs');
export const BUNDLE_INPUTS = join(APP, 'dist', 'bundle-inputs.json');

rmSync(join(APP, 'dist'), { recursive: true, force: true });
const result = await build({
  entryPoints: [join(APP, 'src', 'main.ts')],
  outfile: BUNDLE,
  absWorkingDir: APP,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
// Paths relative to the app folder, sorted, so the file does not depend on the checkout location.
writeFileSync(BUNDLE_INPUTS, `${JSON.stringify(Object.keys(result.metafile.inputs).sort(), null, 2)}\n`);
chmodSync(BUNDLE, 0o755);
console.log(`built ${BUNDLE.slice(APP.length + 1)}`);

// The plugin manifest from the brand module: src/plugin-manifest.ts bundled in memory and imported as a data URL.
const manifestModule = await build({ entryPoints: [join(APP, 'src', 'plugin-manifest.ts')], absWorkingDir: APP, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'warning' });
const { pluginManifestText, PLUGIN_BUNDLE_PATH } = await import(`data:text/javascript;base64,${Buffer.from(manifestModule.outputFiles[0].text).toString('base64')}`);
const PLUGIN = join(APP, 'plugin');
mkdirSync(join(PLUGIN, '.claude-plugin'), { recursive: true });
mkdirSync(join(PLUGIN, 'scripts'), { recursive: true });
writeFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), pluginManifestText());
copyFileSync(BUNDLE, join(PLUGIN, PLUGIN_BUNDLE_PATH));
chmodSync(join(PLUGIN, PLUGIN_BUNDLE_PATH), 0o755);
for (const f of ['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md']) copyFileSync(join(APP, f), join(PLUGIN, f));
console.log(`built plugin/ (${PLUGIN_BUNDLE_PATH}, .claude-plugin/plugin.json, LICENSE, README.md, THIRD-PARTY-NOTICES.md)`);
