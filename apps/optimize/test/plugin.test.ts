// R1-02: the Claude Code plugin's manifest, commands and plugin mode of the CLI, statically.
//   - plugin.json is generated from the brand module (src/plugin-manifest.ts) and the committed file equals that output;
//   - every slash command runs the bundled CLI in plugin mode in its one `!`-line, tells Claude to answer with the
//     verdict line first, and no `!`-line can spend: none carries --yes, --confirmed or --force, and plugin mode turns
//     any `compare` into `--plan-only` (property test over arbitrary argv);
//   - `--plugin --confirmed compare` (the only spending form) appears once, in compare.md's confirm step, and
//     compare.md cannot be started by the model on its own (disable-model-invocation).
// The commands run end to end against a seeded repository in plugin.e2e.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BIN_NAME, CLI_VERSION, COMMAND_PREFIX, PLUGIN_ID, PRODUCT_NAME } from '../src/brand';
import { CONFIRMED_FLAG, main, PLUGIN_FLAG, pluginArgv, versionLine } from '../src/cli';
import { PLUGIN_AUTHOR, PLUGIN_BUNDLE_PATH, PLUGIN_COMMANDS, pluginManifest, pluginManifestText } from '../src/plugin-manifest';
import { CLI_COMMAND, PLUGIN_DIR, readCommand } from './plugin-commands';

const APP = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));

describe('plugin manifest (generated from the brand module)', () => {
  it('the committed plugin.json is exactly what the build writes', () => {
    expect(readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(pluginManifestText());
  });

  it('id, name and version come from the brand module and agree with package.json', () => {
    const m = pluginManifest();
    expect(m.name).toBe(PLUGIN_ID);
    expect(m.displayName).toBe(PRODUCT_NAME);
    expect(m.version).toBe(CLI_VERSION);
    expect(m.version).toBe(pkg.version);
    expect(m.license).toBe(pkg.license);
    expect(m.homepage).toBe(pkg.homepage);
    expect(COMMAND_PREFIX).toBe(`/${m.name}:`);
    expect(PLUGIN_BUNDLE_PATH).toBe(`scripts/${BIN_NAME}.mjs`);
  });

  it('the name is kebab-case and not reserved or read as Anthropic’s own (plugins reference, `name`)', () => {
    const { name } = pluginManifest();
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name).not.toMatch(/claude|anthropic|^cc-plugin-/i);
  });

  it('the author is the LICENSE copyright holder', () => {
    expect(readFileSync(join(APP, 'LICENSE'), 'utf8')).toContain(`Copyright (c) 2026 ${PLUGIN_AUTHOR}\n`);
    expect(pluginManifest().author).toEqual({ name: PLUGIN_AUTHOR });
  });
});

describe('plugin commands', () => {
  const commands = PLUGIN_COMMANDS.map(readCommand);

  it('exactly the five commands of the plan, one file each', () => {
    expect(PLUGIN_COMMANDS).toEqual(['usage', 'import-usage', 'fixture-add', 'compare', 'report']);
    expect(readdirSync(join(PLUGIN_DIR, 'commands')).sort()).toEqual(PLUGIN_COMMANDS.map((c) => `${c}.md`).sort());
  });

  it.each(PLUGIN_COMMANDS)('%s runs the bundled CLI in plugin mode in exactly one !-line, exit code always printed', (name) => {
    const c = readCommand(name);
    expect(c.frontmatter.description).toMatch(new RegExp(`^${PRODUCT_NAME} – `));
    expect(c.frontmatter['allowed-tools']).toBe('Bash(node:*), Read');
    expect(c.bang).toEqual([`node "\${CLAUDE_PLUGIN_ROOT}/${PLUGIN_BUNDLE_PATH}" ${PLUGIN_FLAG} ${CLI_COMMAND[name]} $ARGUMENTS 2>&1; echo "${BIN_NAME} exit code: $?"`]);
  });

  it.each(PLUGIN_COMMANDS)('%s tells Claude to answer with the verdict line first', (name) => {
    expect(readCommand(name).text).toContain('Start your answer with the first line of the output exactly as printed');
  });

  it('no !-line can spend: none carries --yes, --confirmed, --force or --plan-only of its own', () => {
    for (const c of commands) for (const line of c.bang) expect(line).not.toMatch(/--yes|--confirmed|--force|--plan-only/);
  });

  it('commands that read session records or spend cannot be started by the model on its own (legal note §8, L2)', () => {
    for (const name of ['usage', 'import-usage', 'compare'] as const) expect(readCommand(name).frontmatter['disable-model-invocation']).toBe('true');
  });

  it('the spending form appears once, in compare.md’s confirm step, and compare cannot be started by the model', () => {
    const confirmed = commands.flatMap((c) => [...c.text.matchAll(new RegExp(`${PLUGIN_FLAG} ${CONFIRMED_FLAG}`, 'g'))].map(() => c.name));
    expect(confirmed).toEqual(['compare']);
    const compare = readCommand('compare');
    expect(compare.bashBlocks).toEqual([`node "\${CLAUDE_PLUGIN_ROOT}/${PLUGIN_BUNDLE_PATH}" ${PLUGIN_FLAG} ${CONFIRMED_FLAG} compare <the same arguments> 2>&1; echo "${BIN_NAME} exit code: $?"`]);
    expect(compare.frontmatter['disable-model-invocation']).toBe('true');
    // The confirm step comes after the instruction to ask and end the turn.
    expect(compare.text.indexOf('end your turn')).toBeGreaterThan(0);
    expect(compare.text.indexOf('end your turn')).toBeLessThan(compare.text.indexOf(CONFIRMED_FLAG));
    expect(compare.text).toContain("Only when the user's next message clearly says yes to this plan");
  });

  it('every slash command named in the texts uses the brand prefix and exists', () => {
    const refs = commands.flatMap((c) => [...c.text.matchAll(/\/[a-z-]+:[a-z-]+/g)].map((m) => m[0]));
    expect(refs.length).toBeGreaterThan(3);
    for (const r of refs) {
      expect(r.startsWith(COMMAND_PREFIX), r).toBe(true);
      expect(PLUGIN_COMMANDS as readonly string[]).toContain(r.slice(COMMAND_PREFIX.length));
    }
  });
});

describe('plugin mode of the CLI (pluginArgv)', () => {
  it('compare always becomes --plan-only and loses --yes', () => {
    expect(pluginArgv(['compare', '--change', 'p.patch'])).toEqual(['compare', '--change', 'p.patch', '--plan-only']);
    expect(pluginArgv(['compare', '--change', 'p.patch', '--yes', '--force'])).toEqual(['compare', '--change', 'p.patch', '--force', '--plan-only']);
    expect(pluginArgv(['compare', '--yes=true', '--plan-only=false', '--change', 'p'])).toEqual(['compare', '--change', 'p', '--plan-only']);
  });

  it('--confirmed compare is the only form with --yes, and never --plan-only', () => {
    expect(pluginArgv([CONFIRMED_FLAG, 'compare', '--change', 'p.patch', '--plan-only'])).toEqual(['compare', '--change', 'p.patch', '--yes']);
    expect(pluginArgv([CONFIRMED_FLAG, 'usage'])).toEqual({ error: `${CONFIRMED_FLAG} applies to compare only` });
    expect(pluginArgv(['compare', CONFIRMED_FLAG])).toEqual({ error: `${CONFIRMED_FLAG} goes right after ${PLUGIN_FLAG}, once` });
    expect(pluginArgv([CONFIRMED_FLAG, 'compare', CONFIRMED_FLAG])).toEqual({ error: `${CONFIRMED_FLAG} goes right after ${PLUGIN_FLAG}, once` });
  });

  it('other commands pass through unchanged', () => {
    expect(pluginArgv(['fixture', 'add', 'x', '--prompt', 't.md', '--check', 'npm test'])).toEqual(['fixture', 'add', 'x', '--prompt', 't.md', '--check', 'npm test']);
    expect(pluginArgv(['report', 'r.json', '--redact'])).toEqual(['report', 'r.json', '--redact']);
  });

  it('property: whatever the user types after compare, plugin mode ends in --plan-only and holds no --yes', () => {
    const word = fc.oneof(fc.constantFrom('--yes', '--yes=1', '--plan-only', '--force', '--json', '--change', 'p.patch', '--max-runs', '4', '--', '-y'), fc.string());
    fc.assert(
      fc.property(fc.array(word, { maxLength: 12 }), (args) => {
        const out = pluginArgv(['compare', ...args]);
        if (!Array.isArray(out)) return args.includes(CONFIRMED_FLAG);
        return out.at(-1) === '--plan-only' && !out.some((a) => /^--yes(=|$)/.test(a)) && out.filter((a) => a === '--plan-only').length === 1;
      }),
      { numRuns: 500 },
    );
  });

  it('main: a bad plugin form is a usage error; --version passes through', () => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(`out ${l}`), err: (l: string) => lines.push(`err ${l}`) };
    expect(main([PLUGIN_FLAG, CONFIRMED_FLAG, 'usage'], io)).toBe(2);
    expect(lines).toEqual([`err ${BIN_NAME}: ${PLUGIN_FLAG}: ${CONFIRMED_FLAG} applies to compare only`]);
    lines.length = 0;
    expect(main([PLUGIN_FLAG, '--version'], io)).toBe(0);
    expect(lines).toEqual([`out ${versionLine()}`]);
  });

  it('main: an error-only command still prints its error in plugin mode (ordering: plugin.e2e.test.ts)', () => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(`out ${l}`), err: (l: string) => lines.push(`err ${l}`) };
    // An unknown command writes to stderr only; in plugin mode it still comes out, after (empty) stdout.
    expect(main([PLUGIN_FLAG, 'nope'], io)).toBe(2);
    expect(lines).toEqual([`err ${BIN_NAME}: unknown command "nope". Run \`${BIN_NAME} --help\`.`]);
  });
});
