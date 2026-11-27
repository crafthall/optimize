// Static check of R0-12 (legal note §3 finding 2): no source of the CLI or the engine references the places
// Claude Code keeps credentials or the helper that prints a key. Optimize never reads, copies, logs or stores
// credentials, tokens or keychain entries; the unmodified `claude` handles auth on its own.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = [join(import.meta.dirname, '..', 'src'), join(import.meta.dirname, '..', '..', '..', 'libs', 'optimize-engine', 'src')];
/** The one allowed mention (libs/optimize-engine/src/fixture-config.ts, fixtureConfigWarning). */
const NOTE_NAMING_HELPER = 'helper commands such as apiKeyHelper also apply and were not checked.';
const BANNED = [/\.credentials\.json/i, /keychain/i, /security\s+find-generic-password/i, /apiKeyHelper/i, /\bcredentials?\b.*\.json/i];

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx|mts|js|mjs|json)$/.test(e.name) ? [join(dir, e.name)] : []));

describe('no credential handling in source (R0-12, static)', () => {
  const files = ROOTS.flatMap(sources);
  it('the exemption matches exactly one source file (not vacuous, not wider)', () => {
    expect(files.filter((f) => readFileSync(f, 'utf8').includes(NOTE_NAMING_HELPER)).map((f) => f.split('/').pop())).toEqual(['fixture-config.ts']);
  });
  it('scans the CLI and engine sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });
  it.each(files)('%s references no credential store, keychain or key helper', (file) => {
    // One user-facing sentence may name the key helper (legal review of: the fixture security note says it was
    // not checked); it is text, not code that reads the setting. Only that exact sentence is exempt.
    const text = readFileSync(file, 'utf8').replace(NOTE_NAMING_HELPER, '');
    for (const re of BANNED) expect(text, `${file} matches ${re}`).not.toMatch(re);
  });
});
