import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@crafthall/optimize-engine';
import { EXIT, helpText, run, versionLine } from '../src/cli';
import { COMMANDS, matchCommand } from '../src/commands';
import { BIN_NAME, CLI_VERSION, RELEASE_LABEL } from '../src/brand';

const call = (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('crafthall-optimize router', () => {
  it('CLI_VERSION equals package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(CLI_VERSION).toBe(pkg.version);
    expect(Object.keys(pkg.bin)).toEqual([BIN_NAME]);
  });

  it('--version prints the CLI and record schema versions', () => {
    for (const flag of ['--version', '-v', 'version']) expect(call(flag)).toEqual({ code: 0, out: versionLine(), err: '' });
    expect(versionLine()).toBe(`crafthall-optimize ${CLI_VERSION} ${RELEASE_LABEL} (record schema ${SCHEMA_VERSION})`);
  });

  it('--help, -h, help and no arguments print the help with every command of r0 §4', () => {
    for (const argv of [['--help'], ['-h'], ['help'], []]) expect(call(...argv)).toEqual({ code: 0, out: helpText(), err: '' });
    for (const c of ['fixture add', 'fixture list', 'fixture remove', 'config set', 'import-usage', 'compare', 'report']) expect(helpText()).toContain(c);
  });

  it('unknown command or option is a usage error (exit 2)', () => {
    expect(call('frobnicate')).toMatchObject({ code: EXIT.usage, out: '' });
    expect(call('--frob').err).toContain('unknown option');
    expect(call('fixture').code).toBe(EXIT.usage);
  });

  it('a command not built yet exits 2 and names its issue', () => {
    for (const c of COMMANDS.filter((x) => x.plannedIn !== null)) {
      const r = call(...c.path);
      expect(r.code).toBe(EXIT.usage);
      expect(r.err).toContain(`#${c.plannedIn}`);
    }
  });

  it('a built command without its ports is an internal error, not a crash', () => {
    expect(COMMANDS.filter((c) => c.plannedIn === null).map((c) => c.path.join(' '))).toEqual(['fixture add', 'fixture list', 'fixture remove', 'config set', 'import-usage', 'usage', 'compare', 'report']);
    expect(call('fixture', 'list')).toMatchObject({ code: EXIT.internal, out: '' });
  });

  it('<command> --help prints its usage', () => {
    const r = call('compare', '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: crafthall-optimize compare --change <patch-file>');
  });

  it('matches the longest command path', () => {
    expect(matchCommand(['fixture', 'add', 'x'])?.path).toEqual(['fixture', 'add']);
    expect(matchCommand(['fixture'])).toBeUndefined();
  });
});
