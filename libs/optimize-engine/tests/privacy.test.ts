import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createComparisonRecord,
  createFixture,
  findPrivacyLeaks,
  IDENTITY_STOP_WORDS,
  identityTokens,
  NEVER_STORED,
  RecordPrivacyError,
  RecordSchemaError,
  serializeRecord,
  toRepoRelativePath,
  validateRecord,
} from '../src/index';
import { comparisonInput, fixtureInput } from './samples';

describe('toRepoRelativePath', () => {
  it.each([
    ['/r/repo/a/b.md', '/r/repo', 'a/b.md'],
    ['a/./b.md', '/r/repo', 'a/b.md'],
    ['a/../b.md', '/r/repo', 'b.md'],
    ['/r/repo/', '/r/repo', null],
    ['/r/repo-other/a.md', '/r/repo', null],
    ['../x.md', '/r/repo', null],
    ['/elsewhere/x.md', '/r/repo', null],
    ['C:\\Users\\u\\repo\\src\\x.ts', 'C:\\Users\\u\\repo', 'src/x.ts'],
    ['c:\\users\\u\\repo\\src\\x.ts', 'C:\\Users\\u\\repo', 'src/x.ts'],
  ])('%s in %s → %s', (p, root, expected) => {
    expect(toRepoRelativePath(p, root)).toBe(expected);
  });

  it('refuses a relative repo root', () => {
    expect(() => toRepoRelativePath('a', 'repo')).toThrow();
  });
});

describe('findPrivacyLeaks', () => {
  it.each([
    ['/Users/jane/repo/x', 'absolute-path'],
    ['cd ~/repo && npm test', 'absolute-path'],
    ['C:\\work\\repo', 'absolute-path'],
    ['run /opt/tool', 'absolute-path'],
    [`ANTHROPIC_API_KEY=sk-ant-api03-${'a'.repeat(30)}`, 'secret'],
    [`ghp_${'A'.repeat(36)}`, 'secret'],
    ['AKIAABCDEFGHIJKLMNOP', 'secret'],
    ['password: hunter2hunter2', 'secret'],
    ['jane.doe@example.com', 'email'],
  ])('flags %s as %s', (s, kind) => {
    expect(findPrivacyLeaks({ check: s }).map((l) => l.kind)).toContain(kind);
  });

  it('flags identity tokens case-insensitively as whole words, and ignores very short ones', () => {
    expect(findPrivacyLeaks({ v: 'branch FEATURE-acme-42 done' }, { identities: ['feature-acme-42'] })).toEqual([{ path: '/v', kind: 'identity' }]);
    expect(findPrivacyLeaks({ v: 'npx nx test calc-core' }, { identities: ['ab', 'core-x'] })).toEqual([]);
  });

  it('leaves ordinary record strings alone', () => {
    for (const s of ['npx nx test calc-core', 'npm run radar:check', 'fixtures/f1.md', 'sha256:' + 'a'.repeat(64), 'Likely saving, not proven: ratio 0.54 (95% CI 0.41-0.71).', '2.3.1 (Claude Code)'])
      expect(findPrivacyLeaks({ s })).toEqual([]);
  });

  it('a single lower-case segment is a slash command, not a path (#1066: verdict text may name /usage)', () => {
    for (const s of ['run /usage first', '/usage', 'Run /usage.', 'try /effort high', '(see /compact)', 'pasted from /usage, row 2'])
      expect(findPrivacyLeaks({ s }), s).toEqual([]);
    for (const s of ['/x.js', 'node /opt/tool', '/Users', 'cd /home/jane', 'see /usage/x', '/tmp/a.md'])
      expect(findPrivacyLeaks({ s }).map((l) => l.kind), s).toContain('absolute-path');
  });

  it('each word of a multi-word identity counts (a git user name "Jane Q Doe" → Jane, Doe)', () => {
    expect(identityTokens([' Jane Q Doe ', 'jane@example.org', 'ab', 'host-1'])).toEqual(['Jane Q Doe', 'Jane', 'Doe', 'jane@example.org', 'host-1']);
    expect(findPrivacyLeaks({ v: 'fixed by doe' }, { identities: ['Jane Q Doe'] })).toEqual([{ path: '/v', kind: 'identity' }]);
    expect(findPrivacyLeaks({ v: 'Q tasks' }, { identities: ['Jane Q Doe'] })).toEqual([]);
  });

  it('common words of a multi-word or generic identity are no identity tokens (#1118: "Test User" vs `npm test`)', () => {
    expect(identityTokens(['Test User', 'runner', 'localhost', 'Admin', 'Jane Test'])).toEqual(['Test User', 'Jane Test', 'Jane']);
    expect(findPrivacyLeaks({ check: 'npm test', a: 'node user.js' }, { identities: ['Test User', 'runner'] })).toEqual([]);
    expect(findPrivacyLeaks({ v: 'signed: Test User' }, { identities: ['Test User'] })).toEqual([{ path: '/v', kind: 'identity' }]);
  });

  it('property (#1118): a real name word is caught as a whole token in any text, even next to stop words', () => {
    const stop = fc.constantFrom(...IDENTITY_STOP_WORDS);
    const real = fc.stringMatching(/^[A-Z][a-z]{3,9}$/).filter((w) => !IDENTITY_STOP_WORDS.has(w.toLowerCase()));
    const sep = fc.constantFrom(' ', '/', '-', ': ', '(', '#', '.');
    fc.assert(
      fc.property(stop, real, sep, fc.boolean(), fc.boolean(), (s, name, x, first, upper) => {
        const identity = first ? `${name} ${s}` : `${s} ${name}`;
        const text = `npm ${s}${x}${upper ? name.toUpperCase() : name.toLowerCase()}${x}done`;
        expect(findPrivacyLeaks({ v: text }, { identities: [identity] })).toEqual([{ path: '/v', kind: 'identity' }]);
      }),
    );
  });

  it('property (#1118): identities made only of stop words never refuse a command made of the same words', () => {
    const stop = fc.constantFrom(...IDENTITY_STOP_WORDS);
    fc.assert(
      fc.property(fc.array(stop, { minLength: 2, maxLength: 3 }), fc.array(stop, { minLength: 1, maxLength: 4 }), (words, cmd) => {
        const identity = words.join(' ');
        const text = `npm ${cmd.join(' -- ')}`;
        fc.pre(!text.toLowerCase().includes(identity.toLowerCase()));
        expect(findPrivacyLeaks({ v: text }, { identities: [identity, words[0]!] })).toEqual([]);
      }),
    );
  });

  it('names every category of the never-stored list', () => {
    for (const c of ['prompt text', 'file content', 'tool output', 'secrets', 'credentials', 'absolute paths', 'user names', 'host names', 'git author names', 'branch names'])
      expect(NEVER_STORED.join('; ')).toContain(c);
  });

  it('checks keys too', () => {
    expect(findPrivacyLeaks({ '/Users/jane': 1 })).toEqual([{ path: '//Users/jane', kind: 'absolute-path' }]);
  });
});

describe('record builders', () => {
  it('createFixture stores the prompt hash and the repo-relative prompt path only', () => {
    const f = createFixture(fixtureInput());
    expect(validateRecord(f)).toEqual([]);
    expect(f.promptFile).toBe('fixtures/f1.md');
    expect(serializeRecord(f)).not.toContain('off-by-one');
    expect(serializeRecord(f)).not.toContain('sample-user');
  });

  it('createFixture drops a prompt file outside the repo', () => {
    expect(createFixture(fixtureInput({ promptFile: '/tmp/p.md' })).promptFile).toBeUndefined();
  });

  it('createComparisonRecord keeps sorted, unique, in-repo changed files and hashes content', () => {
    const r = createComparisonRecord(comparisonInput());
    expect(validateRecord(r)).toEqual([]);
    expect(r.change.changedFiles).toEqual(['.claude/agents/reviewer.md', 'CLAUDE.md']);
    expect(r.id).toMatch(/^20261126T101500Z-[0-9a-f]{8}$/);
    expect(r.hashes.diff.slice(7, 15)).toBe(r.id.slice(-8));
    expect(serializeRecord(r)).not.toContain('model: inherit');
  });

  it('refuses a success command with a secret or an absolute path (privacy error, value not echoed)', () => {
    const key = `sk-ant-api03-${'Z'.repeat(32)}`;
    const err = (() => {
      try {
        createFixture(fixtureInput({ check: `ANTHROPIC_API_KEY=${key} npm test` }));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(RecordPrivacyError);
    expect(err!.message).not.toContain(key);
    expect(() => createFixture(fixtureInput({ check: 'node /Users/jane/x.js' }))).toThrow(RecordPrivacyError);
  });

  it('refuses a verdict that names the branch or user given as identities', () => {
    const input = comparisonInput({ verdict: { code: 'not-enough-evidence', text: 'Not enough evidence on janedoe-laptop.' } });
    expect(() => createComparisonRecord(input, { identities: ['janedoe-laptop'] })).toThrow(RecordPrivacyError);
  });

  it('refuses schema-invalid input', () => {
    expect(() => createFixture(fixtureInput({ commit: 'HEAD' }))).toThrow(RecordSchemaError);
  });
});

// Property (R0-15 / legal note §1): whatever sensitive material reaches the builders – prompt text full of secrets, paths
// under the user's home, user, host, git identity and branch names – a record the helpers return never contains it.
// Either the builder stores only hashes and repo-relative paths, or it refuses with a privacy or schema error.
describe('property: no record built by the helpers leaks private data', () => {
  const token = fc.stringMatching(/^[a-z][a-z0-9]{4,11}$/);
  const secret = fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9_-]{24,40}$/).map((s) => `sk-ant-api03-${s}`),
    fc.stringMatching(/^[A-Za-z0-9]{36}$/).map((s) => `ghp_${s}`),
    fc.stringMatching(/^[A-Z0-9]{16}$/).map((s) => `AKIA${s}`),
  );
  const env = fc.record({ user: token, host: token.map((h) => `${h}-host`), branch: token.map((b) => `feature/${b}-ticket`), gitName: token, gitLast: token, secret });
  const words = fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 6 }).map((w) => w.join(' '));

  it('fixtures', () => {
    fc.assert(
      fc.property(env, words, fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (e, filler, secretInCheck, pathInCheck, outsidePrompt, nameInCheck) => {
        const repoRoot = `/Users/${e.user}/code/${e.host}-repo`;
        const sensitive = [e.secret, e.user, e.host, e.branch, `${e.gitName}@${e.host}.example`, `/Users/${e.user}`, e.gitLast];
        const promptText = `${filler} ${sensitive.join(' ')} ${filler}`;
        const check = [secretInCheck ? `TOKEN=${e.secret}` : '', pathInCheck ? `node ${repoRoot}/x.js` : '', 'npm test', nameInCheck ? `-- --reporter ${e.gitLast}` : ''].filter(Boolean).join(' ');
        let record;
        try {
          record = createFixture(
            { ...fixtureInput(), repoRoot, promptText, promptFile: outsidePrompt ? `/Users/${e.user}/prompt.md` : `${repoRoot}/p/${filler.replace(/ /g, '-') || 'p'}.md`, check },
            { identities: [e.user, e.host, e.branch, `${e.gitName} ${e.gitLast}`] },
          );
        } catch (err) {
          expect(err instanceof RecordPrivacyError || err instanceof RecordSchemaError).toBe(true);
          expect(secretInCheck || pathInCheck || nameInCheck || err instanceof RecordSchemaError).toBe(true);
          return;
        }
        const text = serializeRecord(record);
        for (const s of sensitive) expect(text).not.toContain(s);
        expect(validateRecord(record)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it('comparison records', () => {
    fc.assert(
      fc.property(env, fc.array(fc.stringMatching(/^[a-z0-9_-]{1,10}(\/[a-z0-9_.-]{1,10}){0,3}$/), { maxLength: 8 }), (e, rel) => {
        const repoRoot = `/home/${e.user}/${e.host}/repo`;
        const sensitive = [e.secret, e.user, e.host, e.branch, `/home/${e.user}`];
        const record = createComparisonRecord(
          comparisonInput({
            repoRoot,
            content: { config: `apiKeyHelper: echo ${e.secret}`, diff: `branch ${e.branch} by ${e.gitName}`, pluginList: e.host },
            changedFiles: [...rel.map((p) => `${repoRoot}/${p}`), `/home/${e.user}/outside.md`],
          }),
          { identities: [e.user, e.host, e.branch] },
        );
        const text = serializeRecord(record);
        for (const s of sensitive) expect(text).not.toContain(s);
        expect(record.change.changedFiles.every((p) => !p.startsWith('/') && !p.split('/').includes('..'))).toBe(true);
        expect(validateRecord(record)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
