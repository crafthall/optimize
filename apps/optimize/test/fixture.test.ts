// `fixture add | list | remove` (R0-05): exit codes and first-line verdicts with fake ports, the privacy
// property over generated prompts, paths and commands, and one pass against real git in a temp repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { parseRecord, validateRecord, type StoreFs } from '@crafthall/optimize-engine';
import { EXIT, run } from '../src/cli';
import { EnvironmentError, type CliDeps } from '../src/deps';
import { branchIdentities, nodeDeps } from '../src/node-deps';

const REPO = '/home/zelda-quist/work/repo';
const SHA = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const FIXTURES = `${REPO}/.crafthall/optimize/fixtures`;

const memoryFs = (): StoreFs & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    files,
    readText: (p) => files.get(p),
    writeText: (p, t) => void files.set(p, t),
    mkdirp: () => undefined,
    list: (d) => [...files.keys()].filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/')).map((p) => p.slice(d.length + 1)),
    remove: (p) => files.delete(p),
  };
};

interface Fake extends CliDeps {
  fs: ReturnType<typeof memoryFs>;
  disk: Map<string, string>;
  dirty: boolean;
}

const fake = (over: Partial<Fake> = {}): Fake => {
  const disk = new Map([[`${REPO}/tasks/f1.md`, 'Fix the off-by-one in roundTo and keep the tests green.']]);
  const deps: Fake = {
    cwd: REPO,
    fs: memoryFs(),
    disk,
    dirty: false,
    git: {
      resolveCommit: (_r, rev) => ({ HEAD: SHA, [SHA]: SHA, [SHA.slice(0, 7)]: SHA, [OLD]: OLD })[rev] ?? null,
      isDirty: () => deps.dirty,
      identities: () => ['Zelda Quist', 'zelda@example.org', 'feature/acme-ticket-42'],
    },
    findRepoRoot: (cwd) => (cwd.startsWith(REPO) ? REPO : null),
    readFile: (p) => deps.disk.get(p),
    now: () => new Date('2026-11-26T10:15:00Z'),
    machineIdentities: () => ['zelda-quist', 'zelda-laptop'],
    toolVersion: (tool) => ({ node: '24.21.0', npm: '10.9.2' })[tool] ?? null,
    randomHex: () => 'ab'.repeat(32),
    runner: { claudeVersion: () => null, claude: () => ({ status: 1, stdout: '', timedOut: false, notFound: true }), check: () => null },
    worktrees: { add: () => '/tmp/wt', apply: () => true, remove: () => undefined },
    hasEnv: () => false,
    confirm: () => null,
    ...over,
  };
  return deps;
};

const call = (deps: CliDeps, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
  return { code, out, err: err.join('\n') };
};

const add = (deps: CliDeps, name = 'f1', ...extra: string[]) => call(deps, 'fixture', 'add', name, '--prompt', 'tasks/f1.md', '--check', 'npm test', ...extra);

describe('fixture add', () => {
  it('stores a schema-valid fixture with the prompt hash, repo-relative path, check, caps and tool versions', () => {
    const d = fake();
    const r = add(d);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toBe(`fixture "f1" added: commit ${SHA.slice(0, 12)}, prompt stored as a salted hash only`);
    const text = d.fs.files.get(`${FIXTURES}/f1.json`)!;
    const parsed = parseRecord(text);
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      kind: 'fixture',
      name: 'f1',
      commit: SHA,
      promptFile: 'tasks/f1.md',
      check: 'npm test',
      caps: { timeoutMin: 15, maxBudgetUsd: 0.5 },
      oracleTools: [{ name: 'node', version: '24.21.0' }, { name: 'npm', version: '10.9.2' }],
      createdAt: '2026-11-26T10:15:00.000Z',
    });
    expect(JSON.parse(text).promptHash).toMatch(/^sha256-salted:/);
    expect(text).not.toContain('off-by-one');
    expect(d.fs.files.get(`${REPO}/.crafthall/optimize/salt`)).toBe(`${'ab'.repeat(32)}\n`);
    expect(r.out.join('\n')).not.toContain(REPO);
  });

  it('takes --commit, caps and a prompt path relative to a subdirectory', () => {
    const d = fake({ cwd: `${REPO}/tasks` });
    const r = call(d, 'fixture', 'add', 'f2', '--prompt', 'f1.md', '--check', 'npx vitest run', '--commit', OLD, '--timeout-min', '30', '--max-budget-usd', '1.25');
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(d.fs.files.get(`${FIXTURES}/f2.json`)!)).toMatchObject({ commit: OLD, promptFile: 'tasks/f1.md', caps: { timeoutMin: 30, maxBudgetUsd: 1.25 } });
  });

  it('resolves a short commit id to the full id', () => {
    const d = fake();
    expect(add(d, 'f1', '--commit', SHA.slice(0, 7)).code).toBe(EXIT.ok);
    expect(JSON.parse(d.fs.files.get(`${FIXTURES}/f1.json`)!).commit).toBe(SHA);
  });

  it.each([
    [['fixture', 'add'], 'expected one fixture name'],
    [['fixture', 'add', 'Bad_Name', '--prompt', 'tasks/f1.md', '--check', 'x'], 'invalid fixture name'],
    [['fixture', 'add', 'f1', '--check', 'npm test'], '--prompt <file> is required'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md'], '--check "<cmd>" is required'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', '   '], '--check "<cmd>" is required'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', 'x'.repeat(501)], 'longer than 500'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', 'x', '--timeout-min', '0'], '--timeout-min'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', 'x', '--max-budget-usd', '101'], '--max-budget-usd'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', 'x', '--frob'], 'Unknown option'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', 'x', '--commit', 'nope'], 'unknown commit "nope"'],
    [['fixture', 'add', 'f1', '--prompt', 'tasks/missing.md', '--check', 'x'], 'prompt file not found'],
    [['fixture', 'add', 'f1', '--prompt', '../outside.md', '--check', 'x'], 'must be inside the repository'],
  ])('usage error (exit 2): %j', (argv, message) => {
    const d = fake();
    const r = call(d, ...argv);
    expect(r).toMatchObject({ code: EXIT.usage, out: [] });
    expect(r.err).toContain(message);
    expect([...d.fs.files.keys()].filter((k) => k.startsWith(FIXTURES))).toEqual([]);
  });

  it('outside a git repository is a usage error', () => {
    expect(add(fake({ cwd: '/elsewhere' })).code).toBe(EXIT.usage);
  });

  it('an empty prompt file is a usage error', () => {
    const d = fake();
    d.disk.set(`${REPO}/tasks/f1.md`, ' \n');
    expect(add(d).err).toContain('prompt file is empty');
  });

  it('refuses a dirty working tree at HEAD (exit 3) but accepts an earlier pinned commit', () => {
    const d = fake();
    d.dirty = true;
    const r = add(d);
    expect(r.code).toBe(EXIT.refused);
    expect(r.err.split('\n')[0]).toMatch(/^refused: the working tree has uncommitted changes/);
    expect(d.fs.files.has(`${FIXTURES}/f1.json`)).toBe(false);
    expect(add(d, 'f1', '--commit', OLD).code).toBe(EXIT.ok);
  });

  it('refuses to overwrite an existing fixture', () => {
    const d = fake();
    expect(add(d).code).toBe(EXIT.ok);
    const r = add(d);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('already exists');
  });

  it.each([
    ['an absolute path', ['--check', 'node /home/zelda-quist/bin/check.mjs'], 'absolute-path'],
    ['the git user name', ['--check', 'npm test # zelda quist'], 'identity'],
    ['the branch name', ['--check', 'npm test -- feature/acme-ticket-42'], 'identity'],
    ['the host name', ['--check', 'ssh zelda-laptop npm test'], 'identity'],
    ['a secret', ['--check', 'API_KEY=sk-ant-abcdefghijklmnop npm test'], 'secret'],
  ])('refuses a check holding %s (exit 2, names the field, not the value)', (_what, extra, kind) => {
    const d = fake();
    const r = call(d, 'fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', ...extra);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain(`/check (${kind})`);
    expect(r.err).not.toContain(extra[1]!);
    expect(d.fs.files.has(`${FIXTURES}/f1.json`)).toBe(false);
  });

  it('accepts `npm test` for a git user "Test User" on a machine "runner", still refuses a real name word', () => {
    const generic = fake({ machineIdentities: () => ['runner', 'localhost'] });
    generic.git = { ...generic.git, identities: () => ['Test User', 'test@example.org', 'main'] };
    for (const check of ['npm test', 'node user.js', 'npm run test -- --user admin']) {
      const r = call(generic, 'fixture', 'add', `f-${check.length}`, '--prompt', 'tasks/f1.md', '--check', check);
      expect(r.code, `${check}: ${r.err}`).toBe(EXIT.ok);
    }
    const named = fake();
    named.git = { ...named.git, identities: () => ['Test Zelda'] };
    const r = call(named, 'fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', 'npm test # zelda');
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('/check (identity)');
  });

  it('git that cannot run is an environment error (exit 4)', () => {
    const d = fake();
    d.git.resolveCommit = () => {
      throw new EnvironmentError('git could not run (ENOENT); install git and retry');
    };
    expect(add(d)).toMatchObject({ code: EXIT.environment });
  });

  it('records no tool version when none can be read', () => {
    const d = fake({ toolVersion: () => null });
    expect(add(d).out.join('\n')).toContain('oracle tools: none detected');
  });
});

describe('fixture list and remove', () => {
  it('list: empty store, then a table with the verdict line first', () => {
    const d = fake();
    expect(call(d, 'fixture', 'list').out[0]).toMatch(/^no fixtures yet/);
    add(d, 'b-task');
    add(d, 'a-task', '--commit', OLD);
    const r = call(d, 'fixture', 'list');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toBe('2 fixtures');
    expect(r.out[1]).toMatch(/^ {2}NAME +COMMIT +CAPS +CHECK$/);
    expect(r.out[2]).toContain('a-task');
    expect(r.out[2]).toContain(OLD.slice(0, 12));
    expect(r.out[3]).toContain('b-task');
  });

  it('list --json prints schema-valid fixture records', () => {
    const d = fake();
    add(d);
    const r = call(d, 'fixture', 'list', '--json');
    const records = JSON.parse(r.out.join('\n')) as unknown[];
    expect(records).toHaveLength(1);
    expect(records.map((x) => validateRecord(x))).toEqual([[]]);
  });

  it('list warns on a corrupt fixture file and still lists the rest', () => {
    const d = fake();
    add(d);
    d.fs.files.set(`${FIXTURES}/broken.json`, '{');
    const r = call(d, 'fixture', 'list');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toBe('1 fixture');
    expect(r.err).toContain('skipped .crafthall/optimize/fixtures/broken.json');
  });

  it('list rejects arguments and works only in a repo', () => {
    expect(call(fake(), 'fixture', 'list', 'x').code).toBe(EXIT.usage);
    expect(call(fake({ cwd: '/elsewhere' }), 'fixture', 'list').code).toBe(EXIT.usage);
  });

  it('remove deletes one fixture; a missing one is a usage error', () => {
    const d = fake();
    add(d);
    expect(call(d, 'fixture', 'remove', 'f1')).toMatchObject({ code: EXIT.ok, out: ['fixture "f1" removed'] });
    expect(d.fs.files.has(`${FIXTURES}/f1.json`)).toBe(false);
    const r = call(d, 'fixture', 'remove', 'f1');
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('no fixture named "f1"');
    expect(call(d, 'fixture', 'remove', '../salt').code).toBe(EXIT.usage);
    expect(d.fs.files.has(`${REPO}/.crafthall/optimize/salt`)).toBe(true);
  });

  it('remove --json prints the removed record; a corrupt file can still be removed', () => {
    const d = fake();
    add(d);
    const r = call(d, 'fixture', 'remove', 'f1', '--json');
    expect(validateRecord(JSON.parse(r.out.join('\n')))).toEqual([]);
    d.fs.files.set(`${FIXTURES}/broken.json`, '{');
    expect(call(d, 'fixture', 'remove', 'broken').code).toBe(EXIT.ok);
  });
});

describe('privacy property: a stored fixture never holds the prompt text, an absolute path or an identity', () => {
  const word = fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/);
  // Identity tokens use letters outside a-f so they can never appear inside a hex hash by chance.
  const identity = fc.stringMatching(/^[g-z]{5,10}$/);
  const segment = fc.oneof(word, fc.constant('..'), fc.constant('.'));

  it('for generated prompts, prompt paths and check commands, a fixture is either refused or clean', () => {
    const outcomes = new Map<string, number>();
    const seen = (key: string) => outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    fc.assert(
      fc.property(
        fc.string({ minLength: 12, maxLength: 200 }).filter((s) => s.trim().length >= 12),
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        fc.array(word, { minLength: 1, maxLength: 4 }),
        identity,
        fc.constantFrom('none', 'check', 'path', 'absolute-check', 'absolute-prompt'),
        (prompt, pathSegments, checkWords, ident, inject) => {
          const d = fake({ machineIdentities: () => [ident] });
          const rel = [...pathSegments, `${inject === 'path' ? ident : 'task'}.md`].join('/');
          const promptPath = inject === 'absolute-prompt' ? `${REPO}/${rel}` : rel;
          d.disk.set(join(REPO, rel), prompt);
          const check = [...checkWords, ...(inject === 'check' ? [ident] : []), ...(inject === 'absolute-check' ? [`${REPO}/x.sh`] : [])].join(' ');
          fc.pre(!check.includes(prompt.trim()) && !rel.includes(prompt.trim()));
          const r = call(d, 'fixture', 'add', 'p1', '--prompt', promptPath, '--check', check);
          const stored = d.fs.files.get(`${FIXTURES}/p1.json`);
          seen(`${inject}:${r.code === EXIT.ok ? 'stored' : 'refused'}`);
          if (r.code !== EXIT.ok) {
            expect(r.code).toBe(EXIT.usage);
            expect(stored).toBeUndefined();
            return;
          }
          expect(stored).toBeDefined();
          const text = stored!;
          expect(text).not.toContain(prompt);
          expect(text.toLowerCase()).not.toContain(ident);
          expect(text).not.toContain(REPO);
          expect(text).not.toMatch(/"(?:\/|~\/|[A-Za-z]:\\\\)/);
          expect(text).not.toMatch(/\s\/[A-Za-z]/);
          expect(parseRecord(text).ok).toBe(true);
          expect(r.out.join('\n')).not.toContain(prompt);
        },
      ),
      { numRuns: 300 },
    );
    // Not vacuous: clean inputs are stored, every injection kind is refused at least once and never stored.
    for (const key of ['none:stored', 'absolute-prompt:stored', 'check:refused', 'path:refused', 'absolute-check:refused']) expect(outcomes.get(key) ?? 0).toBeGreaterThan(0);
    for (const key of ['check:stored', 'path:stored', 'absolute-check:stored']) expect(outcomes.get(key) ?? 0).toBe(0);
  });
});

describe('branchIdentities', () => {
  it.each([
    ['main', []],
    ['HEAD', []],
    ['', []],
    ['feature/acme-ticket-42', ['feature/acme-ticket-42', 'acme-ticket-42']],
    ['users/zelda/fix-login', ['users/zelda/fix-login', 'zelda', 'fix-login']],
    ['acme-rollout', ['acme-rollout']],
  ])('%j → %j', (branch, expected) => expect(branchIdentities(branch)).toEqual(expected));
});

describe('fixture add against real git (temp repository)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'optimize-fixture-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.invalid' } }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.mjs'), 'process.exit(0)\n');
  writeFileSync(join(dir, 'task.md'), 'Make the check pass.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  git('checkout', '-q', '-b', 'feature/acme-ticket-42');
  const head = git('rev-parse', 'HEAD');

  it('pins HEAD, refuses a dirty tree and an unknown commit, then lists and removes', () => {
    const d = nodeDeps(dir);
    expect(call(d, 'fixture', 'add', 'real', '--prompt', 'task.md', '--check', 'node check.mjs').code).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(join(dir, '.crafthall/optimize/fixtures/real.json'), 'utf8'))).toMatchObject({ commit: head, promptFile: 'task.md' });
    expect(call(d, 'fixture', 'add', 'x', '--prompt', 'task.md', '--check', 'node check.mjs', '--commit', 'f'.repeat(40)).code).toBe(EXIT.usage);
    expect(call(d, 'fixture', 'add', 'y', '--prompt', 'task.md', '--check', 'node check.mjs # acme-ticket-42').err).toContain('/check (identity)');
    writeFileSync(join(dir, 'check.mjs'), 'process.exit(1)\n');
    expect(call(d, 'fixture', 'add', 'dirty', '--prompt', 'task.md', '--check', 'node check.mjs').code).toBe(EXIT.refused);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('M check.mjs');
    expect(call(d, 'fixture', 'list').out[0]).toBe('1 fixture');
    expect(call(d, 'fixture', 'remove', 'real').code).toBe(EXIT.ok);
    expect(call(d, 'fixture', 'list').out[0]).toMatch(/^no fixtures yet/);
  });
});
