// CLI interface contract (R0-04; release r0 §4). The spec table and the CLI must agree: this test reads the
// r0 §4 command table and exit-code table and compares them with the command table, `--help` and the code defaults;
// every command's `--help` is snapshotted; exit code 1 is reached through an injected fault in `main`.
// The other exit codes run end to end in test/contract.e2e.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPARE_DEFAULTS, DEFAULT_CV, FIXTURE_DEFAULTS } from '@crafthall/optimize-engine';
import { EXIT, EXIT_CODES, helpText, main, run } from '../src/cli';
import { COMMANDS } from '../src/commands';
import { AUTH_MODES } from '../src/compare';
import type { CliDeps } from '../src/deps';

const R0 = readFileSync(join(import.meta.dirname, 'cli-contract.md'), 'utf8');
const section4 = R0.slice(R0.indexOf('## 4. CLI interface'), R0.indexOf('## 5. '));

const cells = (row: string): string[] => row.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
/** Rows of the markdown table whose header starts with `header`. */
function table(header: string): string[][] {
  const lines = section4.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`| ${header}`));
  expect(start, `table "${header}" in r0 §4`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('|')) break;
    rows.push(cells(l));
  }
  return rows;
}

const flagsIn = (text: string): string[] => [...new Set([...text.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
/** The literal words that select a command: `fixture remove <name>` → `fixture remove`, `config set billing <…>` →
 * `config set billing`; `--version` stays as is. */
function commandPath(spec: string): string {
  if (spec.startsWith('--')) return spec.split(/\s+/)[0]!;
  const words: string[] = [];
  for (const w of spec.split(/\s+/)) {
    if (!/^[a-z][a-z-]*$/.test(w)) break;
    words.push(w);
  }
  return words.join(' ');
}
const cliPath = (c: (typeof COMMANDS)[number]): string => commandPath(c.usage);

interface SpecRow {
  commands: string[];
  flags: string[];
  defaults: Map<string, string>;
}
const specRows: SpecRow[] = table('Command').map(([command, , keyFlags]) => {
  const defaults = new Map<string, string>();
  for (const m of keyFlags!.matchAll(/`(--[a-z-]+)[^`]*`\s*\(([^)]*)\)/g)) {
    const d = /default\s+`?([^`,)]+?)`?(?:[\s,]|$)/.exec(m[2]!);
    if (d) defaults.set(m[1]!, d[1]!);
  }
  return { commands: [...command!.matchAll(/`([^`]+)`/g)].map((m) => commandPath(m[1]!)), flags: keyFlags === '–' ? [] : flagsIn(keyFlags!), defaults };
});

const call = (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('r0 §4 command table and the CLI agree', () => {
  const specCommands = specRows.flatMap((r) => r.commands);

  it('the parser reads the whole table (not vacuous)', () => {
    expect(specRows).toHaveLength(8);
    expect(specRows.find((r) => r.commands.includes('compare'))!.flags).toHaveLength(14);
    expect(specRows.find((r) => r.commands.includes('compare'))!.defaults.size).toBe(6);
    expect(specRows.find((r) => r.commands.includes('fixture add'))!.defaults.size).toBe(3);
  });

  it('the table names every command of the CLI and nothing else', () => {
    expect(specCommands.filter((c) => !c.startsWith('--')).sort()).toEqual(COMMANDS.map(cliPath).sort());
    expect(specCommands.filter((c) => c.startsWith('--')).sort()).toEqual(['--help', '--version']);
  });

  it.each(COMMANDS.map((c) => [cliPath(c), c] as const))('`%s`: the key flags of the table are exactly the flags of its --help', (path, c) => {
    const row = specRows.find((r) => r.commands.includes(path))!;
    expect(row, path).toBeDefined();
    const help = call(...c.path, '--help');
    expect(help.code).toBe(EXIT.ok);
    expect(flagsIn(help.out)).toEqual(row.flags);
  });

  it('the defaults in the table are the defaults in the code', () => {
    const code: Record<string, Record<string, string | number>> = {
      'fixture add': { '--commit': FIXTURE_DEFAULTS.commit, '--timeout-min': FIXTURE_DEFAULTS.timeoutMin, '--max-budget-usd': FIXTURE_DEFAULTS.maxBudgetUsd },
      compare: {
        '--fixtures': 'all',
        '--runs-per-arm': COMPARE_DEFAULTS.runsPerTask,
        '--cv': DEFAULT_CV,
        '--max-budget-usd': COMPARE_DEFAULTS.maxBudgetUsd,
        '--max-runs': COMPARE_DEFAULTS.maxRuns,
        '--auth': AUTH_MODES[0]!,
      },
    };
    for (const [path, expected] of Object.entries(code)) {
      const row = specRows.find((r) => r.commands.includes(path))!;
      const spec = Object.fromEntries([...row.defaults].map(([k, v]) => [k, typeof expected[k] === 'number' ? Number(v) : v]));
      expect(spec, path).toEqual(expected);
    }
  });

  it('--help and --version are top-level options of the help text', () => {
    expect(helpText()).toMatch(/^ {2}-h, --help/m);
    expect(helpText()).toMatch(/^ {2}-v, --version/m);
  });

  it('the exit-code table and the CLI agree: codes 0–5, same meanings, listed in --help', () => {
    const rows = table('Code').map(([code, meaning]) => [Number(code), meaning!] as const);
    expect(rows.map(([c]) => c)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.values(EXIT).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const [code, words] of EXIT_CODES) expect(rows.find(([c]) => c === code)![1].toLowerCase(), `exit ${code}`).toContain(words === 'done' ? 'completed' : words);
    for (const [code, words] of EXIT_CODES) expect(helpText()).toContain(`${code} ${words}`);
  });
});

describe('--help snapshots (contract: a change to the interface shows up in review)', () => {
  it('top level', () => {
    expect(helpText()).toMatchSnapshot();
  });
  it.each(COMMANDS.map((c) => [c.path.join(' '), c] as const))('%s --help', (_path, c) => {
    const r = call(...c.path, '--help');
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe('');
    expect(r.out).toMatchSnapshot();
  });
});

describe('exit code 1: internal error via an injected fault', () => {
  it('an uncaught error in a handler becomes exit 1 with one line on stderr, nothing on stdout', () => {
    const faulty = {
      cwd: '/r/repo',
      findRepoRoot: () => {
        throw new Error('injected fault');
      },
    } as unknown as CliDeps;
    const out: string[] = [];
    const err: string[] = [];
    const code = main(['fixture', 'list'], { out: (l) => out.push(l), err: (l) => err.push(l) }, faulty);
    expect(code).toBe(EXIT.internal);
    expect(out).toEqual([]);
    expect(err).toEqual(['crafthall-optimize: internal error: injected fault']);
  });

  it('main passes every other exit code through unchanged', () => {
    const io = { out: () => undefined, err: () => undefined };
    expect(main(['--version'], io)).toBe(EXIT.ok);
    expect(main(['--frob'], io)).toBe(EXIT.usage);
  });
});
