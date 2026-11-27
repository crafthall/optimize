// `compare` and `report` (R0-06, R0-08) with fake ports and a stubbed runner (recorded `claude -p` JSON):
// spending guard (plan only, payback refusal, confirmation, run cap), interleaving and cold worktrees, version pin,
// model fallback exclusion, and the privacy property of the stored record. Nothing here calls the real `claude`.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRecord, plannedModelMatcher, validateRecord, type ComparisonRecordV1, type StoreFs } from '@crafthall/optimize-engine';
import { EXIT, run } from '../src/cli';
import { API_KEY_ENV, assertAuth, claudeArgs, KEY_SET_IN_SUBSCRIPTION, KEY_SET_REFUSAL, patchFiles, SUBSCRIPTION_NOTICE } from '../src/compare';
import { EnvironmentError, InterruptedError } from '../src/deps';
import { GitTimeoutError, nodeDeps } from '../src/node-deps';
import type { CliDeps, ProcessResult } from '../src/deps';

const REPO = '/home/zelda-quist/work/repo';
const SHA = 'c'.repeat(40);
/** Commit of the second fixture `f2`, when a test adds it. */
const SHA2 = 'd'.repeat(40);
const RECORDS = `${REPO}/.crafthall/optimize/records`;
const PATCH = 'diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-long\n+terse\n';

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

interface Call {
  args: readonly string[];
  cwd: string;
  input: string;
}

interface StubOptions {
  /** Cost of a run by arm and index within the arm. */
  cost?: (arm: 'baseline' | 'changed', i: number) => number;
  /** Model a run reports; `fixture` is the run's fixture (f1, or f2 when `second` is set). */
  model?: (seq: number, fixture: string) => string;
  /** Adds a second fixture `f2` pinned at another commit with its own repo files (: per-fixture model config). */
  second?: { files?: Record<string, string> };
  /** The claude call (0-based) that ends by Ctrl-C: the fake throws InterruptedError like the node runner. */
  interruptAt?: number;
  /**
   * The worktree add (0-based) whose git call times out: the fake throws GitTimeoutError like the node port.
   * Add 0 is the patch check before any run (one fixture), so run k uses add k + 1.
   */
  gitTimeoutAt?: number;
  /** The worktree removal (0-based, removal 0 = the patch check) that throws; the run loop must not mask the cause. */
  removeThrowsAt?: number;
  /** The claude call (0-based) whose run throws an error that is no EnvironmentError (a bug). */
  bugAt?: number;
  versions?: (call: number) => string | null;
  prompt?: string;
  checkExit?: number;
  extraOutput?: string;
  /** Environment variables that are present (presence only; default: ANTHROPIC_API_KEY). */
  env?: readonly string[];
  /** Repo-relative files present in the repo and in every worktree (fixture config). */
  files?: Record<string, string>;
}

interface Fake extends CliDeps {
  traps: number;
  releases: number;
  fs: ReturnType<typeof memoryFs>;
  calls: Call[];
  worktreesMade: string[];
  worktreesRemoved: string[];
  patched: Set<string>;
  answer: boolean | null;
}

const resultJson = (cost: number, model: string, extra = ''): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_api_ms: 12000,
    total_cost_usd: cost,
    result: `done ${extra}`,
    session_id: extra || 'x',
    usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 800 },
    modelUsage: { [model]: { inputTokens: 1000, outputTokens: 800, costUSD: cost } },
  });

function fake(o: StubOptions = {}): Fake {
  const prompt = o.prompt ?? 'Fix the off-by-one in roundTo and keep the tests green.';
  let wt = 0;
  const commitOf = new Map<string, string>();
  let versionCalls = 0;
  const armIndex = { baseline: 0, changed: 0 };
  const deps: Fake = {
    cwd: REPO,
    fs: memoryFs(),
    calls: [],
    worktreesMade: [],
    worktreesRemoved: [],
    patched: new Set(),
    answer: null,
    git: { resolveCommit: (_r, rev) => (rev === 'HEAD' || rev === SHA ? SHA : rev === SHA2 ? SHA2 : null), isDirty: () => false, identities: () => ['Zelda Quist', 'zelda@example.org'] },
    findRepoRoot: (cwd) => (cwd.startsWith(REPO) ? REPO : null),
    readFile: (p) => {
      if (p === `${REPO}/tasks/f1.md` || /^\/tmp\/wt-\d+\/tasks\/f1\.md$/.test(p)) return prompt;
      if (p === `${REPO}/change.patch`) return PATCH;
      if (p.startsWith(RECORDS)) return deps.fs.files.get(p);
      const m = /^(\/tmp\/wt-\d+|\/home\/zelda-quist\/work\/repo)\/(.+)$/.exec(p);
      const rel = m?.[2];
      const files = commitOf.get(m?.[1] ?? '') === SHA2 ? o.second?.files : o.files;
      if (rel && files?.[rel] !== undefined) return files[rel];
      return undefined;
    },
    now: () => new Date('2026-11-26T10:15:00Z'),
    machineIdentities: () => ['zelda-quist', 'zelda-laptop'],
    toolVersion: () => null,
    randomHex: () => 'ab'.repeat(32),
    runner: {
      claudeVersion: () => (o.versions ? o.versions(versionCalls++) : '2.1.0 (Claude Code)'),
      claude: (args, opts): ProcessResult => {
        const seq = deps.calls.length;
        if (o.interruptAt === seq) throw new InterruptedError('SIGINT');
        if (o.bugAt === seq) throw new TypeError('unexpected shape');
        deps.calls.push({ args, cwd: opts.cwd, input: opts.input });
        const arm = deps.patched.has(opts.cwd) ? 'changed' : 'baseline';
        const cost = (o.cost ?? ((a, i) => (a === 'baseline' ? 0.4 : 0.2) * (1 + 0.05 * ((i % 3) - 1))))(arm, armIndex[arm]++);
        const fixture = commitOf.get(opts.cwd) === SHA2 ? 'f2' : 'f1';
        return { status: 0, stdout: resultJson(cost, o.model?.(seq, fixture) ?? 'claude-opus-5-5', o.extraOutput), timedOut: false, notFound: false };
      },
      check: () => o.checkExit ?? 0,
    },
    worktrees: {
      add: (_r, commit) => {
        if (o.gitTimeoutAt === wt) throw new GitTimeoutError(120_000);
        const dir = `/tmp/wt-${++wt}`;
        commitOf.set(dir, commit);
        deps.worktreesMade.push(dir);
        return dir;
      },
      apply: (dir, _patch, checkOnly) => {
        if (!checkOnly) deps.patched.add(dir);
        return true;
      },
      remove: (_r, dir) => {
        deps.worktreesRemoved.push(dir);
        if (o.removeThrowsAt === deps.worktreesRemoved.length - 1) throw new GitTimeoutError(120_000);
      },
    },
    hasEnv: (name) => (o.env ?? ['ANTHROPIC_API_KEY']).includes(name),
    confirm: () => deps.answer,
    trapInterrupts: () => {
      deps.traps++;
      return () => void deps.releases++;
    },
    traps: 0,
    releases: 0,
  };
  const io = { out: () => undefined, err: () => undefined };
  expect(run(['fixture', 'add', 'f1', '--prompt', 'tasks/f1.md', '--check', 'npm test'], io, deps)).toBe(EXIT.ok);
  if (o.second) expect(run(['fixture', 'add', 'f2', '--prompt', 'tasks/f1.md', '--check', 'npm test', '--commit', SHA2], io, deps)).toBe(EXIT.ok);
  return deps;
}

const call = async (deps: CliDeps, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
  return { code, out, err };
};

const storedRecords = (deps: Fake): ComparisonRecordV1[] =>
  [...deps.fs.files.entries()].filter(([p]) => p.startsWith(`${RECORDS}/`)).map(([, t]) => {
    const r = parseRecord(t);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.record as ComparisonRecordV1;
  });

const GO = ['compare', '--change', 'change.patch', '--monthly-volume', '1000'];

describe('compare: spending guard', () => {
  it('--plan-only prints the plan, spends nothing, exits 0', async () => {
    const d = fake();
    const r = await call(d, ...GO, '--plan-only');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toMatch(/^Plan: 8 runs/);
    expect(r.out.join('\n')).toMatch(/planned MDE: +\d+\.\d% saving detectable at n = 4 per arm \(CV 0\.30, assumed – no pilot/);
    expect(r.out.join('\n')).toContain('nothing was run and nothing was spent');
    expect(d.calls).toHaveLength(0);
    expect(storedRecords(d)).toHaveLength(0);
  });

  it('no terminal and no --yes refuses with 3 before any run; declining also refuses', async () => {
    const d = fake();
    expect((await call(d, ...GO)).code).toBe(EXIT.refused);
    d.answer = false;
    expect((await call(d, ...GO)).code).toBe(EXIT.refused);
    expect(d.calls).toHaveLength(0);
    d.answer = true;
    expect((await call(d, ...GO)).code).toBe(EXIT.ok);
    expect(d.calls).toHaveLength(8);
  });

  it('payback over 3 months (or unknown) always refuses with 3 and no run without --force (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 40 }), fc.option(fc.double({ min: 0.01, max: 50, noNaN: true }), { nil: undefined }), async (k, volume) => {
        const d = fake();
        const args = ['compare', '--change', 'change.patch', '--runs-per-arm', String(k), '--yes', '--plan-only'];
        const plan = await call(d, ...args, ...(volume === undefined ? [] : ['--monthly-volume', String(volume)]));
        const payback = /payback horizon: +([\d.]+) months/.exec(plan.out.join('\n'));
        fc.pre(payback === null || Number(payback[1]) > 3);
        const r = await call(d, ...args.slice(0, -1), ...(volume === undefined ? [] : ['--monthly-volume', String(volume)]));
        expect(r.code).toBe(EXIT.refused);
        expect(r.err.find((l) => l.startsWith('refused:'))).toMatch(/^refused: .*(pay back|--monthly-volume|no interval)/);
        expect(d.calls).toHaveLength(0);
      }),
      { numRuns: 60 },
    );
  });

  it('--force overrides the payback refusal', async () => {
    const d = fake();
    expect((await call(d, 'compare', '--change', 'change.patch', '--yes')).code).toBe(EXIT.refused);
    expect((await call(d, 'compare', '--change', 'change.patch', '--yes', '--force')).code).toBe(EXIT.ok);
  });

  it('the runner never gets more than --max-runs calls, each carries --max-budget-usd; capped → 5 and an incomplete record (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 2, max: 14 }), fc.constantFrom('0.25', '1'), async (k, cap, budget) => {
        const d = fake();
        const r = await call(d, ...GO, '--yes', '--force', '--runs-per-arm', String(k), '--max-runs', String(cap), '--max-budget-usd', budget);
        expect(d.calls.length).toBeLessThanOrEqual(cap);
        for (const c of d.calls) expect(c.args.join(' ')).toContain(`--max-budget-usd ${budget}`);
        const capped = 2 * k > cap;
        expect(r.code).toBe(capped ? EXIT.runCap : EXIT.ok);
        const [rec] = storedRecords(d);
        expect(rec!.status).toBe(capped ? 'incomplete' : 'complete');
        expect(validateRecord(rec)).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });

  it('--max-runs below 2 is a usage error: no run of one arm would fit', async () => {
    const d = fake();
    const r = await call(d, ...GO, '--yes', '--max-runs', '1', '--force');
    expect(r.code).toBe(EXIT.usage);
    expect(r.err.join('\n')).toContain('--max-runs must be a whole number from 2 to 10000');
    expect(d.calls).toEqual([]);
  });
});

describe('compare: runs', () => {
  it('runs A/B/A/B, each in a fresh worktree that is removed, prompt on stdin only; writes a schema-valid record', async () => {
    const d = fake();
    const r = await call(d, ...GO, '--yes', '--runs-per-arm', '6');
    expect(r.code).toBe(EXIT.ok);
    expect(d.calls.map((c) => (d.patched.has(c.cwd) ? 'B' : 'A')).join('')).toBe('AB'.repeat(6));
    expect(new Set(d.calls.map((c) => c.cwd)).size).toBe(12);
    expect(d.worktreesRemoved.sort()).toEqual(d.worktreesMade.sort());
    for (const c of d.calls) {
      expect(c.input).toContain('off-by-one');
      expect(c.args.join(' ')).not.toContain('off-by-one');
      expect(c.args).toEqual(claudeArgs({ maxBudgetUsd: 0.5 }));
    }
    const [rec] = storedRecords(d);
    expect(validateRecord(rec)).toEqual([]);
    expect(rec!.runs).toHaveLength(12);
    expect(rec!.change.changedFiles).toEqual(['CLAUDE.md']);
    expect(rec!.verdict.code).toBe('measured-saving');
    expect(r.out[0]).toBe(rec!.verdict.text);
    expect(r.out.join('\n')).toMatch(/measurement cost: USD \d+\.\d\d and [\d,]+ tokens over 12 runs/);
  });

  it('identical arms give "not enough evidence"', async () => {
    const d = fake({ cost: (_a, i) => [0.3, 0.5, 0.4, 0.35][i % 4]! });
    const r = await call(d, ...GO, '--yes', '--runs-per-arm', '4');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toMatch(/^Not enough evidence/);
    expect(storedRecords(d)[0]!.verdict.code).toBe('not-enough-evidence');
  });

  it('a model fallback run is excluded and counted', async () => {
    const d = fake({ model: (seq) => (seq === 3 ? 'claude-haiku-4-5' : 'claude-opus-5-5') });
    expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
    const [rec] = storedRecords(d);
    expect(rec!.exclusions).toEqual([{ seq: 3, reason: 'model-fallback' }]);
    expect(rec!.result.passes.changed.total + rec!.result.passes.baseline.total).toBe(7);
  });

  it('a Claude Code version change mid-comparison stops with 4 and an incomplete record', async () => {
    const d = fake({ versions: (n) => (n < 3 ? '2.1.0 (Claude Code)' : '2.1.1 (Claude Code)') });
    const r = await call(d, ...GO, '--yes');
    expect(r.code).toBe(EXIT.environment);
    expect(r.err.join('\n')).toContain('changed version');
    expect(storedRecords(d)[0]!.status).toBe('incomplete');
  });

  it('claude not on PATH exits 4 before anything runs', async () => {
    const d = fake({ versions: () => null });
    expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.environment);
    expect(d.calls).toHaveLength(0);
  });

  it('usage errors exit 2: missing --change, missing patch, unknown fixture, bad numbers', async () => {
    const d = fake();
    expect((await call(d, 'compare')).code).toBe(EXIT.usage);
    expect((await call(d, 'compare', '--change', 'nope.patch')).code).toBe(EXIT.usage);
    expect((await call(d, ...GO, '--fixtures', 'f9')).code).toBe(EXIT.usage);
    expect((await call(d, ...GO, '--runs-per-arm', '0')).code).toBe(EXIT.usage);
    expect((await call(d, ...GO, '--cv', 'x')).code).toBe(EXIT.usage);
    expect(d.calls).toHaveLength(0);
  });

  it('privacy: the stored record never holds the prompt, absolute paths, identities or a secret from the output (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8, maxLength: 60 }), fc.stringMatching(/^[A-Za-z0-9]{24}$/), async (body, key) => {
        const prompt = `PROMPT-${body}`;
        const secret = `sk-ant-api03-${key}`;
        const d = fake({ prompt, extraOutput: secret });
        expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
        const text = [...d.fs.files.entries()].filter(([p]) => p.startsWith(`${RECORDS}/`)).map(([, t]) => t).join('');
        expect(text.length).toBeGreaterThan(0);
        for (const bad of [prompt, secret, REPO, '/tmp/wt-', 'zelda']) expect(text).not.toContain(bad);
      }),
      { numRuns: 25 },
    );
  });
});

// Untrusted fixture config (R0-13; legal note §3 item 3).
describe('untrusted fixture config', () => {
  const HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node hook.js' }] }] } });
  const MCP = JSON.stringify({ mcpServers: { github: { command: 'npx' } } });
  const files = { '.claude/settings.json': HOOKS, '.mcp.json': MCP };
  const SUB = [...GO, '--runs-per-arm', '1', '--force', '--auth', 'subscription', '--yes'];

  it('fixture add lists the hooks and MCP servers and warns (stderr), still exit 0', async () => {
    const d = fake({ files });
    const r = await call(d, 'fixture', 'add', 'f2', '--prompt', 'tasks/f1.md', '--check', 'npm test');
    expect(r.code).toBe(EXIT.ok);
    const err = r.err.join('\n');
    expect(err).toContain('Security note');
    expect(err).toContain('hook PreToolUse ×1 (.claude/settings.json)');
    expect(err).toContain('MCP server github (.mcp.json)');
    expect(err).toContain('--trust-fixture-config');
    expect((await call(fake(), 'fixture', 'list')).err).toEqual([]);
  });

  it('--auth subscription on such a fixture exits 3 before the plan and any run; --trust-fixture-config runs it', async () => {
    const d = fake({ files, env: [] });
    const r = await call(d, ...SUB);
    expect(r.code).toBe(EXIT.refused);
    expect(r.err.join('\n')).toMatch(/^refused: this fixture repository configures hooks or MCP servers/m);
    expect(r.err.join('\n')).not.toContain('Plan:');
    expect(d.calls).toEqual([]);
    expect(storedRecords(d)).toEqual([]);
    const t = await call(d, ...SUB, '--trust-fixture-config');
    expect(t.code).toBe(EXIT.ok);
    expect(t.err.join('\n')).toContain('you passed --trust-fixture-config');
    expect(d.calls.length).toBe(2);
    for (const c of d.calls) expect(c.args).not.toContain('--bare');
  });

  it('--plan-only in subscription mode spends nothing, exits 0 and says a spending run would be refused', async () => {
    const d = fake({ files, env: [] });
    const r = await call(d, ...GO, '--auth', 'subscription', '--plan-only');
    expect(r.code).toBe(EXIT.ok);
    expect(r.err.join('\n')).toContain('Note: a spending run would be refused');
    expect(d.calls).toEqual([]);
  });

  it('api-key mode runs such a fixture with --bare on every call and says the config is skipped', async () => {
    const d = fake({ files });
    const r = await call(d, ...GO, '--runs-per-arm', '1', '--force', '--yes');
    expect(r.code).toBe(EXIT.ok);
    expect(r.err.join('\n')).toContain('--auth api-key runs use --bare, which does not start them. --bare is not a sandbox');
    expect(d.calls.length).toBe(2);
    for (const c of d.calls) expect(c.args[0]).toBe('--bare');
  });

  it('a repo without hooks or MCP servers gets no note in either mode', async () => {
    for (const env of [['ANTHROPIC_API_KEY'], []]) {
      const d = fake({ env, files: { '.claude/settings.json': JSON.stringify({ permissions: { allow: [] } }) } });
      const r = await call(d, ...GO, '--runs-per-arm', '1', '--force', '--yes', ...(env.length ? [] : ['--auth', 'subscription']));
      expect(r.code).toBe(EXIT.ok);
      expect(r.err.join('\n')).not.toMatch(/Fixture config|refused|Security note/);
    }
  });

  it('subscription mode with ANTHROPIC_API_KEY set (presence only): a spending run exits 3 before the plan and any run', async () => {
    const d = fake();
    const withKey = await call(d, ...SUB);
    expect(withKey.code).toBe(EXIT.refused);
    expect(withKey.err).toEqual([KEY_SET_REFUSAL]);
    expect(KEY_SET_REFUSAL).toBe(`${KEY_SET_IN_SUBSCRIPTION} Refused: unset the key or use --auth api-key.`);
    expect(d.calls).toEqual([]);
    expect(storedRecords(d)).toEqual([]);
  });

  it('subscription --plan-only with the key set only prints the warning, before the plan, exit 0', async () => {
    const r = await call(fake(), ...GO, '--auth', 'subscription', '--plan-only');
    expect(r.code).toBe(EXIT.ok);
    const out = r.out.join('\n');
    expect(out).toContain(KEY_SET_IN_SUBSCRIPTION);
    expect(out).not.toContain('Refused:');
    expect(out.indexOf(KEY_SET_IN_SUBSCRIPTION)).toBeLessThan(out.indexOf('Plan:'));
    expect((await call(fake({ env: [] }), ...SUB)).err.join('\n')).not.toContain(KEY_SET_IN_SUBSCRIPTION);
    expect((await call(fake(), ...GO, '--runs-per-arm', '1', '--force', '--yes')).err.join('\n')).not.toContain(KEY_SET_IN_SUBSCRIPTION);
  });
});

describe('report', () => {
  it('re-prints a stored record by id and by file, verdict first; --json is the record', async () => {
    const d = fake();
    await call(d, ...GO, '--yes');
    const [rec] = storedRecords(d);
    const byId = await call(d, 'report', rec!.id);
    expect(byId.code).toBe(EXIT.ok);
    expect(byId.out[0]).toBe(rec!.verdict.text);
    const byFile = await call(d, 'report', `${RECORDS}/${rec!.id}.json`);
    expect(byFile.out).toEqual(byId.out);
    expect(JSON.parse((await call(d, 'report', rec!.id, '--json')).out.join('\n'))).toEqual(rec);
    expect((await call(d, 'report', 'missing.json')).code).toBe(EXIT.usage);
  });

  it('--redact: same verdict first, share-safe JSON that validates and links to no store, commit or task name', async () => {
    const d = fake();
    await call(d, ...GO, '--yes');
    const [rec] = storedRecords(d);
    const text = await call(d, 'report', rec!.id, '--redact');
    expect(text.code).toBe(EXIT.ok);
    expect(text.out[0]).toBe(rec!.verdict.text);
    expect(text.err.join('\n')).toContain('Share-safe copy');
    const r = await call(d, 'report', rec!.id, '--redact', '--json');
    expect(r.code).toBe(EXIT.ok);
    const red = JSON.parse(r.out.join('\n')) as ComparisonRecordV1;
    expect(validateRecord(red)).toEqual([]);
    const json = r.out.join('\n');
    for (const s of [SHA, rec!.id, rec!.hashes.diff.slice(-64), rec!.fixtures[0]!.promptHash.slice(-64)]) expect(json).not.toContain(s);
    expect(red.fixtures.map((f) => f.name)).toEqual(['task-1']);
    expect(new Set(red.runs.map((x) => x.fixture))).toEqual(new Set(['task-1']));
    expect(red.result).toEqual(rec!.result);
    expect(red.verdict).toEqual(rec!.verdict);
    expect(red.change.changedFiles).toEqual(['CLAUDE.md']);
    // The store is unchanged: the copy is printed, never written.
    expect(storedRecords(d)).toEqual([rec]);
  });
});

describe('helpers', () => {
  it('patchFiles reads the paths of a unified diff; claudeArgs passes --bare by default and drops it only for subscription', () => {
    expect(patchFiles(PATCH)).toEqual(['CLAUDE.md']);
    expect(patchFiles('--- /dev/null\n+++ b/new/file.md\n')).toEqual(['new/file.md']);
    expect(claudeArgs({ maxBudgetUsd: 0.5 })).toEqual(['--bare', '-p', '--output-format', 'json', '--max-budget-usd', '0.5']);
    expect(claudeArgs({ maxBudgetUsd: 0.5, auth: 'api-key' })).toEqual(claudeArgs({ maxBudgetUsd: 0.5 }));
    expect(claudeArgs({ maxBudgetUsd: 1, auth: 'subscription' })).toEqual(['-p', '--output-format', 'json', '--max-budget-usd', '1']);
  });
});

// Auth handling (R0-12; legal note §3): api-key by default with `--bare`, subscription only by explicit flag and
// after the plan-limits notice, presence check of ANTHROPIC_API_KEY only, no secret ever in a record or the output.
describe('compare: auth (R0-12)', () => {
  it('default is api-key: every run gets --bare and the record says auth "api-key"', async () => {
    const d = fake();
    expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
    expect(d.calls.length).toBeGreaterThan(0);
    for (const c of d.calls) expect(c.args[0]).toBe('--bare');
    expect(storedRecords(d)[0]!.auth).toBe('api-key');
  });

  it('api-key without ANTHROPIC_API_KEY exits 4 before any run, naming the flag alternative; --plan-only still plans', async () => {
    const d = fake({ env: [] });
    for (const argv of [[...GO, '--yes'], [...GO, '--auth', 'api-key', '--yes']]) {
      const r = await call(d, ...argv);
      expect(r.code).toBe(EXIT.environment);
      expect(r.err.join('\n')).toContain('ANTHROPIC_API_KEY');
      expect(r.err.join('\n')).toContain('--auth subscription');
      expect(r.err.join('\n')).not.toContain('Plan:');
    }
    expect(d.calls).toHaveLength(0);
    expect(storedRecords(d)).toHaveLength(0);
    expect((await call(d, ...GO, '--plan-only')).code).toBe(EXIT.ok);
    expect(d.calls).toHaveLength(0);
  });

  it('subscription only by explicit flag: notice before the plan, no --bare, needs no key, record says "subscription"', async () => {
    const d = fake({ env: [] });
    const r = await call(d, ...GO, '--auth', 'subscription', '--yes');
    expect(r.code).toBe(EXIT.ok);
    const notice = r.err.findIndex((l) => l.includes(SUBSCRIPTION_NOTICE));
    const plan = r.err.findIndex((l) => l.startsWith('Plan:'));
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(plan);
    for (const c of d.calls) expect(c.args).not.toContain('--bare');
    expect(storedRecords(d)[0]!.auth).toBe('subscription');
    const planOnly = await call(fake(), ...GO, '--auth', 'subscription', '--plan-only');
    expect(planOnly.out.findIndex((l) => l.includes(SUBSCRIPTION_NOTICE))).toBe(0);
    const def = await call(fake(), ...GO, '--plan-only');
    expect([...def.out, ...def.err].join('\n')).not.toContain(SUBSCRIPTION_NOTICE);
  });

  it('subscription keeps the caps and the confirmation: no terminal and no --yes refuses with 3', async () => {
    const d = fake({ env: [] });
    expect((await call(d, ...GO, '--auth', 'subscription')).code).toBe(EXIT.refused);
    expect(d.calls).toHaveLength(0);
    const capped = await call(d, ...GO, '--auth', 'subscription', '--max-runs', '3', '--force', '--yes');
    expect(capped.code).toBe(EXIT.runCap);
    expect(d.calls).toHaveLength(3);
  });

  it('an unknown --auth value is a usage error (2) with nothing run', async () => {
    const d = fake();
    expect((await call(d, ...GO, '--auth', 'oauth', '--yes')).code).toBe(EXIT.usage);
    expect((await call(d, ...GO, '--auth', '', '--yes')).code).toBe(EXIT.usage);
    expect(d.calls).toHaveLength(0);
  });

  it('assertAuth checks presence only and throws EnvironmentError for a missing key', () => {
    const asked: string[] = [];
    expect(() => assertAuth('api-key', (n) => (asked.push(n), false))).toThrow(EnvironmentError);
    expect(asked).toEqual([API_KEY_ENV]);
    expect(() => assertAuth('api-key', () => true)).not.toThrow();
    expect(() => assertAuth('subscription', () => false)).not.toThrow();
  });

  it('node hasEnv: set and non-empty only', () => {
    const name = 'CRAFTHALL_OPTIMIZE_TEST_PRESENCE';
    const deps = nodeDeps();
    delete process.env[name];
    expect(deps.hasEnv(name)).toBe(false);
    process.env[name] = '';
    expect(deps.hasEnv(name)).toBe(false);
    process.env[name] = 'x';
    expect(deps.hasEnv(name)).toBe(true);
    delete process.env[name];
  });

  it('no API-key-shaped value from the environment ever reaches a record, stdout or stderr, in either mode (property)', async () => {
    const saved = process.env[API_KEY_ENV];
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[A-Za-z0-9_-]{20,95}$/),
          fc.constantFrom('sk-ant-api03-', 'sk-ant-admin01-', 'sk-ant-oat01-', ''),
          fc.constantFrom('api-key', 'subscription'),
          fc.boolean(),
          async (body, prefix, auth, json) => {
            const key = `${prefix}${body}`;
            process.env[API_KEY_ENV] = key;
            // The real presence check over process.env, and a runner whose output even echoes the key (worst case).
            const d = fake({ extraOutput: key });
            d.hasEnv = nodeDeps().hasEnv;
            const r = await call(d, ...GO, '--auth', auth, '--yes', ...(json ? ['--json'] : []));
            // Subscription mode with the key set refuses before any run (legal review); the key still never shows.
            expect(r.code).toBe(auth === 'subscription' ? EXIT.refused : EXIT.ok);
            const stored = [...d.fs.files.entries()].filter(([p]) => p.startsWith(`${RECORDS}/`)).map(([, t]) => t);
            expect(stored.length > 0).toBe(auth === 'api-key');
            if (auth === 'subscription') expect(d.calls).toEqual([]);
            for (const text of [...stored, ...r.out, ...r.err]) expect(text).not.toContain(key);
            for (const c of d.calls) expect([...c.args, c.input].join(' ')).not.toContain(key);
          },
        ),
        { numRuns: 40 },
      );
    } finally {
      if (saved === undefined) delete process.env[API_KEY_ENV];
      else process.env[API_KEY_ENV] = saved;
    }
  });
});

describe('billing mode and cost labels (R0-10, R0-11)', () => {
  const CONFIG = `${REPO}/.crafthall/optimize/config.json`;

  it('config set billing stores the mode locally; a bad key or mode is a usage error (2)', async () => {
    const deps = fake();
    const r = await call(deps, 'config', 'set', 'billing', 'subscription');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toContain('Billing mode set to subscription');
    expect(JSON.parse(deps.fs.files.get(CONFIG)!)).toEqual({ billing: 'subscription' });
    expect((await call(deps, 'config', 'set', 'billing', 'free')).code).toBe(EXIT.usage);
    expect((await call(deps, 'config', 'set', 'colour', 'api')).code).toBe(EXIT.usage);
    expect(JSON.parse(deps.fs.files.get(CONFIG)!)).toEqual({ billing: 'subscription' });
  });

  it('unset mode is asked once and stored; the next report reads the stored value without asking', async () => {
    const deps = fake();
    deps.answer = true;
    const asked: string[] = [];
    deps.ask = (q) => (asked.push(q), 'credits');
    expect((await call(deps, ...GO, '--runs-per-arm', '2')).code).toBe(EXIT.ok);
    expect(asked).toHaveLength(1);
    expect(JSON.parse(deps.fs.files.get(CONFIG)!)).toEqual({ billing: 'credits' });
    const second = await call(deps, ...GO, '--runs-per-arm', '2');
    expect(second.code).toBe(EXIT.ok);
    expect(asked).toHaveLength(1);
    // Same diff and clock → same record id: the second run overwrites the first; its labels come from the stored mode.
    expect(storedRecords(deps).map((r) => r.labels)).toEqual([{ billing: 'credits', measurementCost: 'api-billing', saving: 'usage-credits' }]);
  });

  it('no terminal and unset: nothing stored, the hint is printed, labels say "unset" and the API-equivalent estimate', async () => {
    const deps = fake();
    deps.answer = true;
    const r = await call(deps, ...GO, '--runs-per-arm', '2', '--json');
    expect(r.code).toBe(EXIT.ok);
    expect(deps.fs.files.has(CONFIG)).toBe(false);
    expect(r.err.join('\n')).toContain('config set billing');
    const json = JSON.parse(r.out.join('\n')) as ComparisonRecordV1;
    expect(json.labels).toEqual({ billing: 'unset', measurementCost: 'api-billing', saving: 'api-equivalent-estimate' });
    expect(validateRecord(json)).toEqual([]);
  });

  it('subscription mode: the plan and report speak of plan capacity, never money saved', async () => {
    const deps = fake({ env: [] });
    deps.answer = true;
    await call(deps, 'config', 'set', 'billing', 'subscription');
    const r = await call(deps, ...GO, '--runs-per-arm', '2', '--auth', 'subscription');
    expect(r.code).toBe(EXIT.ok);
    const all = [...r.err, ...r.out].join('\n');
    expect(r.err.join('\n')).toMatch(/expected cost: +at most USD [\d.]+, every run at its --max-budget-usd cap \(subscription capacity valued at API list price, not money you pay/);
    expect(r.out.join('\n')).toContain('On a Pro, Max or Ultra plan a saving is plan capacity, not money; it does not lower your subscription price.');
    expect(r.out.join('\n')).toMatch(/measurement cost: USD [\d.]+ .*\(subscription capacity/);
    expect(all).not.toMatch(/you saved|API billing/i);
    expect(storedRecords(deps)[0]!.labels).toEqual({ billing: 'subscription', measurementCost: 'subscription-capacity', saving: 'subscription-capacity' });
  });

  it('report of a record without labels (schema 1.1.0) labels it from its auth and the stored mode; --json adds labels', async () => {
    const deps = fake();
    deps.answer = true;
    await call(deps, ...GO, '--runs-per-arm', '2');
    const [rec] = storedRecords(deps);
    const old: Partial<ComparisonRecordV1> = { ...rec! };
    delete old.labels;
    const path = `${RECORDS}/${rec!.id}.json`;
    deps.fs.files.set(path, JSON.stringify({ ...old, schemaVersion: '1.1.0' }));
    await call(deps, 'config', 'set', 'billing', 'api');
    const text = await call(deps, 'report', rec!.id);
    expect(text.code).toBe(EXIT.ok);
    expect(text.out.join('\n')).toContain('saving counts as: API billing: a saving lowers your per-token cost');
    const json = JSON.parse((await call(deps, 'report', rec!.id, '--json')).out.join('\n')) as ComparisonRecordV1;
    expect(json.labels).toEqual({ billing: 'api', measurementCost: 'api-billing', saving: 'api-billing' });
  });
});

// Model pin per arm and Ctrl-C.
describe('compare: model per arm', () => {
  const armOf = (seq: number) => (seq % 2 === 0 ? 'baseline' : 'changed');
  it('two arms on different models: nothing excluded, both models stored and reported', async () => {
    const d = fake({ model: (seq) => (armOf(seq) === 'baseline' ? 'claude-opus-5-5' : 'claude-sonnet-5-5') });
    const r = await call(d, ...GO, '--yes');
    expect(r.code).toBe(EXIT.ok);
    const [rec] = storedRecords(d);
    expect(rec!.exclusions).toEqual([]);
    expect(rec!.versions.modelByArm).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' });
    expect(rec!.versions.model).toBe('claude-opus-5-5');
    expect(rec!.result.costRatio).not.toBeNull();
    expect(r.out.join('\n')).toContain('model baseline claude-opus-5-5, changed claude-sonnet-5-5');
  });

  it('a mid-arm model change in one arm is still excluded; the other arm is untouched', async () => {
    const d = fake({ model: (seq) => (armOf(seq) === 'baseline' ? 'claude-opus-5-5' : seq === 5 ? 'claude-haiku-4-5' : 'claude-sonnet-5-5') });
    expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
    const [rec] = storedRecords(d);
    expect(rec!.exclusions).toEqual([{ seq: 5, reason: 'model-fallback' }]);
    expect(rec!.versions.modelByArm).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' });
  });

  it('the plan shows the configured model per arm (.claude/settings.json at the commit, then patched)', async () => {
    const d = fake({ files: { '.claude/settings.json': '{"model":"claude-opus-5-5"}' } });
    const r = await call(d, ...GO, '--plan-only');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.join('\n')).toContain('model per arm:    baseline claude-opus-5-5, changed claude-opus-5-5');
  });

  // QA review §11 ruling 1: a fallback on an arm's first counted run must not become the pin when the arm's
  // planned model (.claude/settings.json at the commit / with the patch) is known – it would exclude every on-plan run.
  it('a fallback on the first run does not pin the arm when the planned model is known (alias or full id)', async () => {
    for (const planned of ['opus', 'claude-opus-5-5']) {
      const d = fake({ files: { '.claude/settings.json': JSON.stringify({ model: planned }) }, model: (seq) => (seq === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5') });
      expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
      const [rec] = storedRecords(d);
      expect(rec!.exclusions).toEqual([{ seq: 0, reason: 'model-fallback' }]);
      expect(rec!.versions.modelByArm).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-opus-5-5' });
    }
  });

  it('a planned model the matcher cannot read (opusplan) keeps the first-counted-run pin', async () => {
    const d = fake({ files: { '.claude/settings.json': '{"model":"opusplan"}' }, model: (seq) => (seq === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5') });
    expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
    const [rec] = storedRecords(d);
    expect(rec!.versions.modelByArm).toEqual({ baseline: 'claude-sonnet-5-5', changed: 'claude-opus-5-5' });
  });

  it('property: over generated model sequences, exactly the runs off their own arm\'s first model are excluded', async () => {
    const models = fc.constantFrom('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5');
    await fc.assert(
      fc.asyncProperty(fc.array(models, { minLength: 8, maxLength: 8 }), async (seqModels) => {
        const d = fake({ model: (seq) => seqModels[seq]! });
        expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
        const [rec] = storedRecords(d);
        const first = { baseline: seqModels[0]!, changed: seqModels[1]! };
        const expected = seqModels.flatMap((m, seq) => (m !== first[armOf(seq)] ? [{ seq, reason: 'model-fallback' }] : []));
        expect(rec!.exclusions).toEqual(expected);
        expect(rec!.versions.modelByArm).toEqual(first);
      }),
      { numRuns: 60 },
    );
  });
});

// Model pin per (arm, fixture) (stats review §11 item 1 follow-up): fixtures configured with different models
// are measured, not excluded wholesale; a model change within one (arm, fixture) is still a fallback.
describe('compare: model per (arm, fixture)', () => {
  const settings = (model: string) => ({ '.claude/settings.json': JSON.stringify({ model }) });
  const byFixture = (fixture: string) => (fixture === 'f1' ? 'claude-opus-5-5' : 'claude-sonnet-5-5');

  it('two fixtures configured with different models: nothing excluded (failing before: every f2 run was a fallback)', async () => {
    const d = fake({ files: settings('opus'), second: { files: settings('sonnet') }, model: (_seq, fixture) => byFixture(fixture) });
    const r = await call(d, ...GO, '--yes', '--force');
    expect(r.code, r.err.join('\n')).toBe(EXIT.ok);
    const [rec] = storedRecords(d);
    expect(validateRecord(rec)).toEqual([]);
    expect(new Set(rec!.runs.map((x) => x.fixture))).toEqual(new Set(['f1', 'f2']));
    expect(rec!.exclusions).toEqual([]);
    expect(rec!.versions.modelByArm).toEqual({ baseline: 'claude-opus-5-5', changed: 'claude-opus-5-5' });
  });

  it('fixtures with no configured model share one pin per arm: a fixture whose runs report another model is excluded', async () => {
    // Both inherit the same user or environment model, so a different model on f2 is a fallback (QA review).
    const d = fake({ second: {}, model: (_seq, fixture) => byFixture(fixture) });
    expect((await call(d, ...GO, '--yes', '--force')).code).toBe(EXIT.ok);
    const [rec] = storedRecords(d);
    const f2 = rec!.runs.filter((x) => x.fixture === 'f2').map((x) => ({ seq: x.seq, reason: 'model-fallback' }));
    expect(f2.length).toBeGreaterThan(0);
    expect(rec!.exclusions).toEqual(f2);
  });

  // QA review (stats review §11, sign-off finding 1), fixed by the pin key arm + configured model. Fixtures
  // with no configured model (or the same configured value) get their model from the same user settings / environment,
  // so a fallback on f2's first baseline run (seq 2) should be caught by f1's baseline pin, as it was under. With
  // a pin per (arm, fixture) it pins f2's baseline to the fallback model instead, every on-plan f2 baseline run
  // (seq 6, 10, 14) is excluded, and `versions.modelByArm` (f1's pin) hides it from the T1 protocol check.
  it('review – fixtures sharing one configured model (here none) share one pin per arm', async () => {
    const d = fake({ second: {}, model: (seq) => (seq === 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5') });
    expect((await call(d, ...GO, '--yes', '--force')).code).toBe(EXIT.ok);
    expect(storedRecords(d)[0]!.exclusions).toEqual([{ seq: 2, reason: 'model-fallback' }]);
  });

  it('a model change within one (arm, fixture) is still excluded; other fixtures and arms are untouched', async () => {
    let switched = -1;
    const d = fake({
      files: settings('opus'),
      second: { files: settings('sonnet') },
      model: (seq, fixture) => {
        // The second run of f2 that reaches the stub falls back to Haiku.
        if (fixture === 'f2' && switched === -1 && seq > 4) switched = seq;
        return seq === switched ? 'claude-haiku-4-5' : byFixture(fixture);
      },
    });
    expect((await call(d, ...GO, '--yes', '--force')).code).toBe(EXIT.ok);
    const [rec] = storedRecords(d);
    expect(switched).toBeGreaterThan(0);
    expect(rec!.exclusions).toEqual([{ seq: switched, reason: 'model-fallback' }]);
  });

  it('property: over generated configurations and model sequences of two fixtures, exactly the runs off their own (arm, configured model) group\'s plan or first model are excluded', async () => {
    const models = fc.constantFrom('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5');
    const config = fc.constantFrom(null, 'opus', 'sonnet');
    await fc.assert(
      fc.asyncProperty(fc.array(models, { minLength: 16, maxLength: 16 }), config, config, async (seqModels, c1, c2) => {
        const d = fake({ ...(c1 ? { files: settings(c1) } : {}), second: c2 ? { files: settings(c2) } : {}, model: (seq) => seqModels[seq]! });
        expect((await call(d, ...GO, '--yes', '--force')).code).toBe(EXIT.ok);
        const [rec] = storedRecords(d);
        // Oracle: one pin per arm and configured value (the patch leaves settings.json alone, so both arms read it).
        const first = new Map<string, string>();
        const expected: { seq: number; reason: string }[] = [];
        for (const run of [...rec!.runs].sort((a, b) => a.seq - b.seq)) {
          const cfg = run.fixture === 'f1' ? c1 : c2;
          const key = `${run.arm}|${cfg ?? '-'}`;
          const plan = plannedModelMatcher(cfg);
          const pinned = first.get(key);
          if (pinned === undefined) {
            if (plan && !plan(run.metrics.model)) expected.push({ seq: run.seq, reason: 'model-fallback' });
            else first.set(key, run.metrics.model);
          } else if (pinned !== run.metrics.model) expected.push({ seq: run.seq, reason: 'model-fallback' });
        }
        expect(rec!.runs).toHaveLength(16);
        expect(rec!.exclusions).toEqual(expected);
      }),
      { numRuns: 40 },
    );
  });
});

describe('compare: Ctrl-C', () => {
  it('an interrupted run stops scheduling, removes every worktree, writes a valid incomplete record of the runs done, exits 5', async () => {
    const d = fake({ interruptAt: 3 });
    const r = await call(d, ...GO, '--yes');
    expect(r.code).toBe(EXIT.runCap);
    expect(r.err.join('\n')).toContain('stopped: interrupted (SIGINT)');
    // Calls 0-2 finished; call 3 was interrupted (the fake throws before logging it); nothing ran after it.
    expect(d.calls).toHaveLength(3);
    expect([...d.worktreesRemoved].sort()).toEqual([...d.worktreesMade].sort());
    expect(d.traps).toBe(1);
    expect(d.releases).toBe(1);
    const [rec] = storedRecords(d);
    expect(validateRecord(rec)).toEqual([]);
    expect(rec!.status).toBe('incomplete');
    expect(rec!.runs.map((x) => x.seq)).toEqual([0, 1, 2]);
  });

  it('an interrupt in the first run stores an incomplete record with no runs (exit 5)', async () => {
    const d = fake({ interruptAt: 0 });
    expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.runCap);
    const [rec] = storedRecords(d);
    expect(rec!.status).toBe('incomplete');
    expect(rec!.runs).toEqual([]);
    expect(rec!.versions.model).toBe('unknown');
    expect([...d.worktreesRemoved].sort()).toEqual([...d.worktreesMade].sort());
  });
});

// Informative censoring (stats review §11 item 2): a record the user interrupted is never a "measured saving".
describe('compare: the verdict of an interrupted record is capped at "likely saving"', () => {
  it('the same 7 runs: stopped by the run cap → measured saving; interrupted → likely saving, stop "interrupted" (failing before)', async () => {
    const capped = fake();
    expect((await call(capped, ...GO, '--yes', '--force', '--max-runs', '7')).code).toBe(EXIT.runCap);
    const [cap] = storedRecords(capped);
    expect(cap!.stop).toBe('run-cap');
    expect(cap!.verdict.code).toBe('measured-saving');

    const stopped = fake({ interruptAt: 7 });
    const r = await call(stopped, ...GO, '--yes');
    expect(r.code).toBe(EXIT.runCap);
    const [rec] = storedRecords(stopped);
    expect(validateRecord(rec)).toEqual([]);
    expect(rec!.stop).toBe('interrupted');
    expect(rec!.runs.map((x) => x.seq)).toEqual(cap!.runs.map((x) => x.seq));
    expect(rec!.result).toEqual(cap!.result);
    expect(rec!.verdict.code).toBe('likely-saving');
    expect(rec!.verdict.text).toMatch(/^Likely saving, not proven: .*incomplete – interrupted\)?\.$/);
    expect(r.out[0]).toBe(rec!.verdict.text);
    expect(r.err.join('\n')).toContain('verdict at most "likely saving"');
    // report re-derives the same capped verdict from the stored record.
    expect((await call(stopped, 'report', rec!.id)).out[0]).toBe(rec!.verdict.text);
  });

  it('a complete record has no stop field', async () => {
    const d = fake();
    expect((await call(d, ...GO, '--yes')).code).toBe(EXIT.ok);
    expect(storedRecords(d)[0]!.stop).toBeUndefined();
  });
});

describe('compare: an environment error mid-comparison keeps the completed runs', () => {
  it('git timing out at run 4 stops scheduling, removes every worktree, stores a valid incomplete record of runs 0-3, exits 4', async () => {
    const d = fake({ gitTimeoutAt: 4 + 1 });
    const r = await call(d, ...GO, '--yes');
    expect(r.code).toBe(EXIT.environment);
    const [rec] = storedRecords(d);
    expect(validateRecord(rec)).toEqual([]);
    expect(rec!.status).toBe('incomplete');
    expect(rec!.runs.map((x) => x.seq)).toEqual([0, 1, 2, 3]);
    expect(d.calls).toHaveLength(4);
    expect([...d.worktreesRemoved].sort()).toEqual([...d.worktreesMade].sort());
    expect(d.releases).toBe(1);
    const err = r.err.join('\n');
    expect(err).toContain(`stopped: git timed out after 120 s (machine busy?); 4 runs completed, recorded in .crafthall/optimize/records/${rec!.id}.json (incomplete)`);
    expect(err).not.toContain('install git');
  });

  it('an error before the first completed run keeps the old behaviour: exit 4, no record', async () => {
    const d = fake({ gitTimeoutAt: 0 + 1 });
    const r = await call(d, ...GO, '--yes');
    expect(r.code).toBe(EXIT.environment);
    expect(d.calls).toHaveLength(0);
    expect(r.err.join('\n')).toContain('git timed out after 120 s (machine busy?)');
    expect(storedRecords(d)).toHaveLength(0);
  });

  it('property: a git timeout at any run k ≥ 1 stores exactly runs 0..k-1 and cleans every worktree; k = 0 stores nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 7 }), async (k) => {
        const d = fake({ gitTimeoutAt: k + 1 });
        const r = await call(d, ...GO, '--yes');
        expect(r.code).toBe(EXIT.environment);
        expect([...d.worktreesRemoved].sort()).toEqual([...d.worktreesMade].sort());
        expect(d.worktreesMade).toHaveLength(k + 1);
        expect(d.calls).toHaveLength(k);
        const recs = storedRecords(d);
        expect(recs).toHaveLength(k === 0 ? 0 : 1);
        if (k === 0) return;
        expect(validateRecord(recs[0])).toEqual([]);
        expect(recs[0]!.status).toBe('incomplete');
        expect(recs[0]!.runs.map((x) => x.seq)).toEqual([...Array(k).keys()]);
        expect(r.err.join('\n')).toContain(`; ${k} ${k === 1 ? 'run' : 'runs'} completed, recorded in`);
      }),
      { numRuns: 24 },
    );
  });

  it('a failing worktree removal after a completed run is the cause: the run is kept, the record is incomplete, exit 4', async () => {
    const d = fake({ removeThrowsAt: 2 + 1 });
    const r = await call(d, ...GO, '--yes');
    expect(r.code).toBe(EXIT.environment);
    const [rec] = storedRecords(d);
    expect(rec!.runs.map((x) => x.seq)).toEqual([0, 1, 2]);
    expect(d.calls).toHaveLength(3);
    expect(r.err.join('\n')).toContain('stopped: git timed out after 120 s (machine busy?); 3 runs completed');
  });

  it('any other error after a completed run also keeps the runs; a bug exits 1, not 4', async () => {
    const d = fake({ bugAt: 2 });
    const r = await call(d, ...GO, '--yes');
    expect(r.code).toBe(EXIT.internal);
    const [rec] = storedRecords(d);
    expect(validateRecord(rec)).toEqual([]);
    expect(rec!.runs.map((x) => x.seq)).toEqual([0, 1]);
    expect([...d.worktreesRemoved].sort()).toEqual([...d.worktreesMade].sort());
    expect(r.err.join('\n')).toContain('stopped: unexpected shape; 2 runs completed');
  });
});
