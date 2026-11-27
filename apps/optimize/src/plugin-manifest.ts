// The Claude Code plugin manifest (R1-02): `plugin/.claude-plugin/plugin.json`, written by scripts/build.mjs from
// this function, so its id, name and version come from the brand module (R1-01). test/plugin.test.ts checks the
// committed file equals this output. Fields: https://code.claude.com/docs/en/plugins-reference ("Fields"; `name` is the
// only required key, kebab-case, every command is namespaced under it).
import { BIN_NAME, CLI_VERSION, HOMEPAGE, PLUGIN_ID, PRODUCT_NAME } from './brand';

/** The slash commands of the plugin, in the order of the README; each is `plugin/commands/<name>.md`. */
export const PLUGIN_COMMANDS = ['usage', 'import-usage', 'fixture-add', 'compare', 'report'] as const;

/** Where the plugin keeps the CLI bundle, relative to the plugin root. */
export const PLUGIN_BUNDLE_PATH = `scripts/${BIN_NAME}.mjs`;

/** The copyright holder of LICENSE, named as the plugin author (as Crafthall HQ's plugin does). */
export const PLUGIN_AUTHOR = 'Lukasz Pawelczak';

export interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: { name: string };
  homepage: string;
  license: string;
  keywords: string[];
}

export const pluginManifest = (): PluginManifest => ({
  name: PLUGIN_ID,
  displayName: PRODUCT_NAME,
  version: CLI_VERSION,
  description:
    'Count your Claude Code token use, get ranked fixes to try (estimated, not measured), and measure one setup change with paired runs of your own tasks. A comparison shows its plan and expected cost first and runs only after you confirm. Optimize itself sends nothing to Crafthall; comparisons are ordinary Claude Code runs on your own account. Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.',
  author: { name: PLUGIN_AUTHOR },
  homepage: HOMEPAGE,
  license: 'MIT',
  keywords: ['tokens', 'usage', 'cost', 'measurement', 'claude-md'],
});

/** The manifest file text as the build writes it. */
export const pluginManifestText = (): string => `${JSON.stringify(pluginManifest(), null, 2)}\n`;
