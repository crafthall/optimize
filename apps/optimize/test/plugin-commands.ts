// Reads the plugin's slash commands (R1-02) the way Claude Code does for what the tests need: the front matter,
// the `!`-lines (run before the command's text reaches Claude; https://code.claude.com/docs/en/slash-commands, "The
// !`command` syntax") and the fenced bash blocks (the confirm step of compare). Used by plugin.test.ts (static rules)
// and plugin.e2e.test.ts (runs the lines against a seeded repository with a stub `claude`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_COMMANDS } from '../src/plugin-manifest';

export const PLUGIN_DIR = join(import.meta.dirname, '..', 'plugin');

export type PluginCommand = (typeof PLUGIN_COMMANDS)[number];

/** The CLI command each slash command runs. */
export const CLI_COMMAND: Readonly<Record<PluginCommand, string>> = {
  usage: 'usage',
  'import-usage': 'import-usage',
  'fixture-add': 'fixture add',
  compare: 'compare',
  report: 'report',
};

export interface CommandFile {
  name: PluginCommand;
  text: string;
  frontmatter: Record<string, string>;
  /** The command lines of every inline `!`…`` at the start of a line. */
  bang: string[];
  /** The contents of every ```bash block. */
  bashBlocks: string[];
}

export function readCommand(name: PluginCommand): CommandFile {
  const text = readFileSync(join(PLUGIN_DIR, 'commands', `${name}.md`), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const frontmatter = Object.fromEntries(
    (fm?.[1] ?? '')
      .split('\n')
      .map((l) => /^([\w-]+):\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
  const bang = [...text.matchAll(/^!`([^`]+)`\s*$/gm)].map((m) => m[1]!);
  const bashBlocks = [...text.matchAll(/^\s*```bash\n([\s\S]*?)\n\s*```/gm)].map((m) => m[1]!.trim());
  return { name, text, frontmatter, bang, bashBlocks };
}

/** A command line as Claude Code runs it: `${CLAUDE_PLUGIN_ROOT}` is the plugin root, `$ARGUMENTS` the typed text. */
export const substitute = (line: string, root: string, args: string): string =>
  line.split('${CLAUDE_PLUGIN_ROOT}').join(root).split('$ARGUMENTS').join(args);
