// Untrusted fixture config (R0-13): which hooks and MCP servers a non-bare `claude -p` would run in a fixture
// repo, the security note of `fixture add`, and the schema minor-version read rule of ADR-0001 (parseRecord).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeFixtureConfigRisks, findFixtureConfigRisks, fixtureConfigWarning, hasFixtureConfigRisks, newerMinor, parseRecord, SCHEMA_VERSION, serializeRecord } from '../src/index';
import { validFixture } from './samples';

const reader = (files: Record<string, string>) => (rel: string) => files[rel];

describe('findFixtureConfigRisks', () => {
  it('finds hook commands per event and file, and MCP servers in .mcp.json and settings', () => {
    const r = findFixtureConfigRisks(
      reader({
        '.claude/settings.json': JSON.stringify({
          hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }], Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] },
        }),
        '.claude/settings.local.json': JSON.stringify({ mcpServers: { local_db: { command: 'x' } } }),
        '.mcp.json': JSON.stringify({ mcpServers: { github: { command: 'npx' }, 'bad name; rm -rf': {} } }),
      }),
    );
    expect(r.hooks).toEqual([
      { file: '.claude/settings.json', event: 'PreToolUse', count: 2 },
      { file: '.claude/settings.json', event: 'Stop', count: 1 },
    ]);
    expect(r.mcpServers).toEqual([
      { file: '.claude/settings.local.json', name: 'local_db' },
      { file: '.mcp.json', name: 'github' },
      { file: '.mcp.json', name: '<unnamed>' },
    ]);
    expect(describeFixtureConfigRisks(r)[0]).toBe('hook PreToolUse ×2 (.claude/settings.json)');
    expect(hasFixtureConfigRisks(r)).toBe(true);
  });

  it('no config, empty hooks or settings without hooks → no risk', () => {
    const cases: Record<string, string>[] = [{}, { '.claude/settings.json': '{"hooks":{}}' }, { '.claude/settings.json': '{"permissions":{"allow":["Bash"]}}', '.mcp.json': '{"mcpServers":{}}' }];
    for (const files of cases)
      expect(hasFixtureConfigRisks(findFixtureConfigRisks(reader(files)))).toBe(false);
  });

  it('a config file that is not valid JSON counts as a risk (it cannot be checked)', () => {
    const r = findFixtureConfigRisks(reader({ '.mcp.json': '{ not json' }));
    expect(r.unreadable).toEqual(['.mcp.json']);
    expect(hasFixtureConfigRisks(r)).toBe(true);
  });

  it('the security note names every finding, the --bare default and the opt-in flag, and claims nothing is safe', () => {
    const lines = fixtureConfigWarning(findFixtureConfigRisks(reader({ '.mcp.json': '{"mcpServers":{"github":{}}}' })), 'crafthall-optimize');
    expect(lines.join('\n')).toContain('MCP server github (.mcp.json)');
    expect(lines.join('\n')).toContain('--bare');
    expect(lines.join('\n')).toContain('--trust-fixture-config');
    expect(lines.join('\n')).not.toMatch(/\bsafe\b|guarantee|secure/i);
    expect(lines[0]).toBe('Security note: this repository configures hooks or MCP servers that Claude Code starts on its own (only these were checked):');
    expect(lines).toContain(
      'Without --bare, a `claude -p` run starts these hooks and connects these MCP servers with no trust dialog, so commands from this repository run on your machine. Its settings `env` block and helper commands such as apiKeyHelper also apply and were not checked.',
    );
    expect(lines).toContain(
      "`crafthall-optimize compare` runs with --bare by default (--auth api-key), which does not start them; --bare is not a sandbox, and the fixture's check command still runs this repository's code. With --auth subscription it refuses this fixture unless you pass --trust-fixture-config.",
    );
  });

  it('property: never throws on any text and prints only short plain names', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('.claude/settings.json', '.claude/settings.local.json', '.mcp.json'), fc.oneof(fc.string(), fc.json())), (files) => {
        const lines = describeFixtureConfigRisks(findFixtureConfigRisks(reader(files)));
        for (const l of lines) expect(l).toMatch(/^(hook [A-Za-z0-9._@<>-]+ ×\d+|MCP server [A-Za-z0-9._@<>-]+|\S+ is not valid JSON)/);
      }),
      { numRuns: 300 },
    );
  });
});

describe('schema minor-version read rule (ADR-0001)', () => {
  const [major, minor] = SCHEMA_VERSION.split('.').map(Number);
  it('reads its own major with a minor up to its own', () => {
    for (let m = 0; m <= minor!; m++) expect(newerMinor(`${major}.${m}.7`)).toBeNull();
    expect(parseRecord(serializeRecord({ ...validFixture(), schemaVersion: `${major}.0.0` })).ok).toBe(true);
  });

  it('refuses a newer minor with a hint to update, also when the record has no new field', () => {
    const v = `${major}.${minor! + 1}.0`;
    expect(newerMinor(v)).toContain('update it');
    const r = parseRecord(serializeRecord({ ...validFixture(), schemaVersion: v }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ path: '/schemaVersion' });
  });
});
