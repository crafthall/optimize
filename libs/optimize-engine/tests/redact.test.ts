// Share-safe export (`report --redact`, R0-03; legal note §1 rule 3): unit examples and the fast-check property
// that no redacted record holds a generated secret, absolute path, user or host name, git identity, branch name,
// fixture name, commit id or original hash – and that it still validates and keeps the figures and the verdict.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createComparisonRecord, findPrivacyLeaks, recordVerdictText, redactPath, redactRecord, serializeRecord, validateRecord, type ComparisonRecordV1 } from '../src/index';
import { comparisonInput } from './samples';

const SALT = '5a'.repeat(32);

describe('redactPath', () => {
  it.each([
    ['CLAUDE.md', 1, 'CLAUDE.md'],
    ['.mcp.json', 1, '.mcp.json'],
    ['.claude/settings.json', 1, '.claude/settings.json'],
    ['.claude/agents/acme-billing.md', 2, '.claude/agents/redacted-2.md'],
    ['.claude/skills/acme-deploy/SKILL.md', 3, '.claude/skills/redacted-3/SKILL.md'],
    ['.claude/acme-private/x.md', 4, 'redacted-4.md'],
    ['apps/acme-portal/CLAUDE.md', 5, 'redacted-5/CLAUDE.md'],
    ['src/customers/acme.ts', 6, 'redacted-6.ts'],
    ['Makefile', 7, 'redacted-7'],
  ])('%s → %s', (p, n, expected) => {
    expect(redactPath(p, n as number)).toBe(expected);
  });
});

describe('redactRecord', () => {
  const record = createComparisonRecord(comparisonInput({ salt: 'f0'.repeat(32) }));

  it('replaces hashes, commit ids, fixture names and non-config paths; keeps figures, versions and verdict', () => {
    const red = redactRecord(record, { salt: SALT });
    expect(validateRecord(red)).toEqual([]);
    expect(red.fixtures).toHaveLength(1);
    expect(red.fixtures[0]!.name).toBe('task-1');
    expect(red.runs.every((r) => r.fixture === 'task-1')).toBe(true);
    expect(red.change.changedFiles).toEqual(['.claude/agents/redacted-1.md', 'CLAUDE.md']);
    expect(red.createdAt).toBe('2026-11-26T00:00:00Z');
    expect(red.id).toMatch(/^20261126T000000Z-[0-9a-f]{8}$/);
    expect(red.id.slice(-8)).toBe(red.hashes.diff.slice(14, 22));
    const text = serializeRecord(red);
    for (const s of [record.id, record.fixtures[0]!.commit, record.fixtures[0]!.name, 'reviewer', ...Object.values(record.hashes).map((h) => h.slice(-64))])
      expect(text).not.toContain(s);
    expect({ result: red.result, verdict: red.verdict, versions: red.versions, plan: red.plan, exclusions: red.exclusions }).toEqual({
      result: record.result,
      verdict: record.verdict,
      versions: record.versions,
      plan: record.plan,
      exclusions: record.exclusions,
    });
    expect(red.runs.map((r) => r.metrics)).toEqual(record.runs.map((r) => r.metrics));
  });

  it('is deterministic for one salt, unlinkable across salts, and keeps equal values equal', () => {
    expect(redactRecord(record, { salt: SALT })).toEqual(redactRecord(record, { salt: SALT }));
    expect(redactRecord(record, { salt: 'c3'.repeat(32) }).hashes.diff).not.toBe(redactRecord(record, { salt: SALT }).hashes.diff);
    const same = createComparisonRecord(comparisonInput({ arms: [{ arm: 'baseline', configHash: `sha256:${'e'.repeat(64)}` }, { arm: 'changed', configHash: `sha256:${'e'.repeat(64)}` }] }));
    const red = redactRecord(same, { salt: SALT });
    expect(red.arms[0]!.configHash).toBe(red.arms[1]!.configHash);
  });

  it('keeps the metric and the per-model token sums, so a redacted token record re-prints in token use (review)', () => {
    const tok: ComparisonRecordV1 = {
      ...record,
      schemaVersion: '1.5.0',
      metric: 'tokens',
      runs: record.runs.map((r, i) => ({ ...r, metrics: { ...r.metrics, modelUsageTokens: { input: 100 + i, cacheWrite: 2000, cacheRead: 30000 + 7 * i, output: 400 } } })),
    };
    expect(validateRecord(tok)).toEqual([]);
    const red = redactRecord(tok, { salt: SALT });
    expect(validateRecord(red)).toEqual([]);
    expect(red.metric).toBe('tokens');
    expect(red.runs.map((r) => r.metrics.modelUsageTokens)).toEqual(tok.runs.map((r) => r.metrics.modelUsageTokens));
    expect(recordVerdictText(red)).toBe(recordVerdictText(tok));
    expect(recordVerdictText(red)).not.toMatch(/cost ratio/);
    // A redacted cost record (no metric) stays without one – it is not silently turned into a token record.
    expect(redactRecord(record, { salt: SALT }).metric).toBeUndefined();
  });

  it('refuses a weak salt', () => {
    expect(() => redactRecord(record, { salt: 'abc' })).toThrow(RangeError);
  });
});

// Property (R0-03): whatever names a record carries – fixture names, changed paths and commits built from the user's,
// host's, branch's and git user's words – the redacted copy holds none of them, nor any original hash, and validates.
describe('property: a redacted record leaks nothing', () => {
  const token = fc.stringMatching(/^[a-z][a-z0-9]{4,11}$/);
  const hex40 = fc.stringMatching(/^[0-9a-f]{40}$/);
  const env = fc.record({ user: token, host: token, branch: token, first: token, last: token, ticket: token });

  it('holds', () => {
    fc.assert(
      fc.property(env, fc.array(fc.tuple(token, hex40), { minLength: 1, maxLength: 4 }), fc.array(token, { maxLength: 5 }), fc.stringMatching(/^[0-9a-f]{64}$/), (e, fx, dirs, salt) => {
        const repoRoot = `/home/${e.user}/${e.host}/repo`;
        const words = [e.user, e.host, e.branch, e.first, e.last, e.ticket];
        const fixtures = fx.map(([w, commit], i) => ({ name: `${words[i % words.length]}-${w}-${i}`, commit, promptHash: `sha256-salted:${commit}${commit.slice(0, 24)}` }));
        const runs = fixtures.flatMap((f, i) => [
          { seq: 2 * i, fixture: f.name, arm: 'baseline' as const, oracleExitCode: 0, metrics: comparisonInput().runs[0]!.metrics },
          { seq: 2 * i + 1, fixture: f.name, arm: 'changed' as const, oracleExitCode: 0, metrics: comparisonInput().runs[1]!.metrics },
        ]);
        // Built without identities: a record from another machine, or one whose names the store did not know.
        const record: ComparisonRecordV1 = createComparisonRecord(
          comparisonInput({
            repoRoot,
            fixtures,
            runs,
            exclusions: [],
            changedFiles: ['CLAUDE.md', ...dirs.map((d, i) => `${repoRoot}/${d}/${words[i % words.length]}/${e.ticket}.md`), `${repoRoot}/.claude/agents/${e.branch}.md`],
          }),
        );
        const identities = [e.user, e.host, e.branch, `${e.first} ${e.last}`, `${e.first}@${e.host}.example`];
        const red = redactRecord(record, { salt, identities });
        const text = serializeRecord(red);
        expect(validateRecord(red)).toEqual([]);
        expect(findPrivacyLeaks(red, { identities: [...identities, e.ticket] })).toEqual([]);
        for (const f of fixtures) {
          expect(text).not.toContain(f.commit);
          expect(text).not.toContain(f.promptHash.slice(-64));
          expect(text).not.toContain(`"${f.name}"`);
        }
        for (const h of Object.values(record.hashes)) expect(text).not.toContain(h.slice(-64));
        expect(red.change.changedFiles).toContain('CLAUDE.md');
        expect(red.result).toEqual(record.result);
      }),
      { numRuns: 300 },
    );
  }, 30_000); // Wall-clock budget only: ~2 s alone, over 5 s under optimize:verify load; the assertions are unchanged.
});
