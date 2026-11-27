// Command router of the Crafthall Optimize CLI. Pure apart from the injected output, so tests call it directly.
// Exit codes (release r0 §4): 0 done, 1 internal error (main.ts), 2 usage error, 3 refused by a guard,
// 4 environment error, 5 run cap reached or interrupted (Ctrl-C).
import { SCHEMA_VERSION } from '@crafthall/optimize-engine';
import { COMMANDS, matchCommand } from './commands';
import { BIN_NAME, CLI_VERSION, DISPLAY_VERSION, PRODUCT_NAME } from './brand';
import type { CliDeps } from './deps';
import { configSet } from './billing';
import { compare, report } from './compare';
import { EXIT, type Io } from './exit';
import { importUsage } from './import-usage';
import { usage } from './usage';
import { fixtureAdd, fixtureList, fixtureRemove, type Handler } from './fixture';

export { EXIT, type Io } from './exit';

/** Built handlers by command path (`fixture add`, …); the router falls back to "not built yet" for the rest. */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  'fixture add': fixtureAdd,
  'fixture list': fixtureList,
  'fixture remove': fixtureRemove,
  'config set': configSet,
  'import-usage': importUsage,
  usage,
  compare,
  report,
};

/** Exit codes in --help, in the words of r0 §4 (the contract test checks both agree). */
export const EXIT_CODES: readonly (readonly [number, string])[] = [
  [EXIT.ok, 'done'],
  [EXIT.internal, 'internal error'],
  [EXIT.usage, 'usage error'],
  [EXIT.refused, 'refused by a guard'],
  [EXIT.environment, 'environment error'],
  [EXIT.runCap, 'run cap reached or interrupted'],
];

/** `crafthall-optimize 0.1.0 beta (record schema <semver>)`: binary, version with its release label (R1-01), schema. */
export const versionLine = (): string => `${BIN_NAME} ${DISPLAY_VERSION} (record schema ${SCHEMA_VERSION})`;

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.path.join(' ').length));
  return [
    `${PRODUCT_NAME} – measure whether a change to your Claude Code setup saves cost while your tasks still pass.`,
    'Runs on this machine. Makes no network call of its own; the only traffic is your own `claude -p` runs during `compare`.',
    '',
    `Usage: ${BIN_NAME} <command> [options]`,
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.path.join(' ').padEnd(width)}  ${c.summary}${c.plannedIn ? ` (not built yet, #${c.plannedIn})` : ''}`),
    '',
    'Options:',
    '  -h, --help     Show this help (or `<command> --help`)',
    '  -v, --version  Show the version and the record schema version',
    '',
    `Exit codes: ${EXIT_CODES.map(([code, meaning]) => `${code} ${meaning}`).join(', ')}.`,
    '',
    'Data: fixtures and records are stored in <repo>/.crafthall/optimize/ (own .gitignore); never prompt text, file',
    'content, tool output, secrets, credentials, absolute paths, user or host names, git names or e-mails, or branch names.',
    '`report --redact` prints a share-safe copy of a record.',
  ].join('\n');
}

/**
 * The whole CLI as main.ts runs it: the router, with any uncaught error mapped to exit 1 (internal error – a bug) and
 * a one-line message on stderr. Exported so the contract test can inject a fault.
 */
export function main(argv: readonly string[], io: Io, deps?: CliDeps): number | Promise<number> {
  if (argv[0] === PLUGIN_FLAG) return pluginMain(argv.slice(1), io, deps);
  const internal = (e: unknown): number => {
    io.err(`${BIN_NAME}: internal error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.internal;
  };
  try {
    const code = run(argv, io, deps);
    return typeof code === 'number' ? code : code.catch(internal);
  } catch (e) {
    return internal(e);
  }
}

/**
 * Routes argv to a command. `deps` (files, git, clock) is needed only by built commands; main.ts passes nodeDeps.
 * Every command returns its exit code synchronously except `compare`, whose run loop is async.
 */
export function run(argv: readonly string[], io: Io, deps?: CliDeps): number | Promise<number> {
  const [first] = argv;
  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    io.out(helpText());
    return EXIT.ok;
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    io.out(versionLine());
    return EXIT.ok;
  }
  const command = matchCommand(argv);
  if (!command) {
    io.err(`${BIN_NAME}: unknown ${first.startsWith('-') ? 'option' : 'command'} "${first}". Run \`${BIN_NAME} --help\`.`);
    return EXIT.usage;
  }
  const rest = argv.slice(command.path.length);
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(`Usage: ${BIN_NAME} ${command.usage}\n\n${command.summary}.`);
    return EXIT.ok;
  }
  if (command.plannedIn !== null) {
    io.err(`${BIN_NAME}: \`${command.path.join(' ')}\` is not built yet in ${CLI_VERSION} (#${command.plannedIn}).`);
    return EXIT.usage;
  }
  const handler = HANDLERS[command.path.join(' ')];
  if (!handler || !deps) {
    io.err(`${BIN_NAME}: \`${command.path.join(' ')}\` has no handler.`);
    return EXIT.internal;
  }
  return handler(rest, io, deps);
}

/**
 * Plugin mode (R1-02): the Claude Code plugin's slash commands call the bundled CLI as
 * `<bin> --plugin <command> [args]`. Not in --help: it is the plugin's interface, not a user option.
 *   - The verdict comes first: stdout lines are written as they come, stderr lines (billing hint, plan block of a
 *     spending run, progress notes) are held and written after the command ends, so the first output line is the
 *     command's verdict or summary line (r0 §4 output rules) even when the plugin merges both streams.
 *   - No terminal: stdin is never read and every question (confirm, billing) answers "no terminal", so a slash command
 *     never waits for input it cannot get.
 *   - A plugin-started `compare` always stops at the plan (R0-08): `--plugin compare …` runs with `--plan-only` and
 *     drops any `--yes`, whatever the user typed. The spending run is a separate call, `--plugin --confirmed compare …`,
 *     which the plugin's compare command makes only after the user confirmed the plan in the chat; it is the only
 *     plugin form that passes `--yes`.
 */
export const PLUGIN_FLAG = '--plugin';
/** Second plugin-mode word: the user confirmed the plan in the chat, so `compare` may spend (adds `--yes`). */
export const CONFIRMED_FLAG = '--confirmed';

/** The CLI argv a plugin-mode call runs, or a usage error message. Pure. */
export function pluginArgv(rest: readonly string[]): string[] | { error: string } {
  const confirmed = rest[0] === CONFIRMED_FLAG;
  const args = confirmed ? rest.slice(1) : [...rest];
  if (args.includes(CONFIRMED_FLAG)) return { error: `${CONFIRMED_FLAG} goes right after ${PLUGIN_FLAG}, once` };
  if (args[0] !== 'compare') {
    if (confirmed) return { error: `${CONFIRMED_FLAG} applies to compare only` };
    return args;
  }
  // `--yes`, `--plan-only` and their `--flag=value` forms are dropped and set again by the plugin mode alone.
  const own = (a: string) => /^--(yes|plan-only)(=.*)?$/.test(a);
  return ['compare', ...args.slice(1).filter((a) => !own(a)), confirmed ? '--yes' : '--plan-only'];
}

function pluginMain(rest: readonly string[], io: Io, deps?: CliDeps): number | Promise<number> {
  const argv = pluginArgv(rest);
  if (!Array.isArray(argv)) {
    io.err(`${BIN_NAME}: ${PLUGIN_FLAG}: ${argv.error}`);
    return EXIT.usage;
  }
  const held: string[] = [];
  const flush = (code: number): number => {
    for (const l of held) io.err(l);
    return code;
  };
  const noTerminal: Partial<CliDeps> = { confirm: () => null, ask: () => null, readStdin: () => null };
  const code = main(argv, { out: io.out, err: (l) => held.push(l) }, deps && { ...deps, ...noTerminal });
  return typeof code === 'number' ? flush(code) : code.then(flush);
}
