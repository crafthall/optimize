// `import-usage` (R0-09) through the router with fake ports: exit codes, the first-line summary, --json, the
// opt-in transcript read, and a fast-check property that neither the output nor the store ever holds generated
// secrets, prompt text, absolute paths or identities (nothing is stored at all).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreFs } from '@crafthall/optimize-engine';
import { EXIT, run } from '../src/cli';
import type { CliDeps } from '../src/deps';

const REPO = '/home/zelda-quist/work/repo';
const HOME = '/home/zelda-quist';
const PROJECTS = `${HOME}/.claude/projects/-home-zelda-quist-work-repo`;

const fake = (disk: Record<string, string> = {}, stdin: string | null = null) => {
  const reads: string[] = [];
  const writes: string[] = [];
  const files = new Map(Object.entries(disk));
  const fs: StoreFs = {
    readText: (p) => files.get(p),
    writeText: (p) => void writes.push(p),
    mkdirp: (p) => void writes.push(p),
    list: (d) => {
      reads.push(d);
      const names = new Set<string>();
      for (const p of files.keys()) if (p.startsWith(`${d}/`)) names.add(p.slice(d.length + 1).split('/')[0]!);
      return [...names];
    },
    remove: () => false,
  };
  const deps: CliDeps = {
    cwd: REPO,
    fs,
    git: { resolveCommit: () => null, isDirty: () => false, identities: () => ['Zelda Quist', 'zelda@example.org', 'feature/acme-ticket-42', 'acme-ticket-42'] },
    findRepoRoot: (cwd) => (cwd.startsWith(REPO) ? REPO : null),
    readFile: (p) => {
      reads.push(p);
      return files.get(p);
    },
    now: () => new Date('2026-11-26T10:00:00Z'),
    machineIdentities: () => ['zelda-quist', 'zelda-laptop'],
    toolVersion: () => null,
    randomHex: () => 'ab'.repeat(32),
    runner: { claudeVersion: () => null, claude: () => ({ status: 1, stdout: '', timedOut: false, notFound: true }), check: () => null },
    worktrees: { add: () => '/tmp/wt', apply: () => true, remove: () => undefined },
    hasEnv: () => false,
    confirm: () => null,
    readStdin: () => stdin,
    homeDir: () => HOME,
  };
  return { deps, reads, writes };
};

const call = (deps: CliDeps, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
  return { code, out, err: err.join('\n') };
};

const ROWS = '25%  Trim ~/work/repo/CLAUDE.md · 49k tokens per request\n40%  Switch from max to high effort · /effort high\n';
const SESSION = [
  { type: 'assistant', requestId: 'r1', timestamp: '2026-11-20T09:00:00Z', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 30000 } } } },
  { type: 'assistant', requestId: 'r2', timestamp: '2026-11-20T09:20:00Z', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 30000 } } } },
  { type: 'assistant', requestId: 'r3', timestamp: '2026-11-20T09:21:00Z', message: { usage: { input_tokens: 5, cache_read_input_tokens: 30000, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100 } } } },
]
  .map((r) => JSON.stringify(r))
  .join('\n');

describe('import-usage', () => {
  it('pasted rows on stdin → ranked hypotheses, summary first, exit 0, nothing stored, no transcript read', () => {
    const { deps, reads, writes } = fake({ [`${REPO}/CLAUDE.md`]: '# x\n' }, ROWS);
    const r = call(deps, 'import-usage');
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe('');
    expect(r.out[0]).toBe('2 hypotheses to test with compare (estimated, not measured): 2 from native /usage rows, 0 from non-native checks; 0 estimated, not measurable');
    expect(r.out).toContain('1. [native /usage row] Switch from max to high effort · /effort high');
    expect(r.out).toContain('2. [native /usage row] Trim CLAUDE.md · 49k tokens per request');
    expect(r.out.join('\n')).toContain('D2 idle-gap vs cache TTL fit: skipped – needs your session timestamps: pass --read-transcripts <dir>');
    expect(writes).toEqual([]);
    expect(reads.some((p) => p.includes('/.claude/projects'))).toBe(false);
  });

  it('--usage-file (and --file) read the rows from a file; --json gives the same list as JSON', () => {
    const { deps } = fake({ [`${REPO}/usage.txt`]: ROWS });
    const a = call(deps, 'import-usage', '--usage-file', 'usage.txt', '--json');
    const b = call(deps, 'import-usage', '--file', `${REPO}/usage.txt`, '--json');
    expect(a.code).toBe(EXIT.ok);
    const json = JSON.parse(a.out.join('\n'));
    expect(json).toMatchObject({ kind: 'crafthall-optimize/hypotheses', format: 1, inputs: { usageRows: 2, transcripts: null } });
    expect(json.hypotheses.map((h: { label: string }) => h.label)).toEqual(['estimated, not measured', 'estimated, not measured']);
    expect(b.out).toEqual(a.out);
  });

  it('--read-transcripts reads only the given folder (and its subagents) and runs D2', () => {
    const { deps, reads } = fake({ [`${PROJECTS}/s1.jsonl`]: SESSION, [`${PROJECTS}/s1/subagents/agent-a.jsonl`]: SESSION }, '');
    const r = call(deps, 'import-usage', '--read-transcripts', PROJECTS, '--json');
    expect(r.code).toBe(EXIT.ok);
    const json = JSON.parse(r.out.join('\n'));
    expect(json.inputs.transcripts).toMatchObject({ sessions: 2, requests: 6 });
    expect(json.checks[0]).toMatchObject({ id: 'D2', status: 'ran' });
    expect(json.hypotheses.map((h: { id: string }) => h.id)).toContain('D2-ttl-1h');
    expect(reads.filter((p) => p.endsWith('.jsonl')).sort()).toEqual([`${PROJECTS}/s1.jsonl`, `${PROJECTS}/s1/subagents/agent-a.jsonl`]);
    expect(r.out.join('\n')).not.toContain('zelda');
  });

  it('empty stdin and no findings → "No hypotheses" summary, exit 0', () => {
    const r = call(fake({}, '').deps, 'import-usage');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toBe('No hypotheses (estimated, not measured): no /usage rows pasted and the non-native checks found nothing');
  });

  it.each([
    ['malformed rows', ['import-usage'], '150%  Trim CLAUDE.md', /line 1: a \/usage row share must be between 0% and 100%/],
    ['text with no /usage line', ['import-usage'], 'hello there', /no \/usage line found/],
    ['a missing usage file', ['import-usage', '--usage-file', 'nope.txt'], null, /--usage-file was not found/],
    ['--otel (not built yet)', ['import-usage', '--otel', 'x.json'], null, /--otel is not built yet/],
    ['a positional argument', ['import-usage', 'rows.txt'], null, /unexpected argument/],
    ['an unknown flag', ['import-usage', '--nope'], null, /Unknown option/],
    ['an empty transcripts folder', ['import-usage', '--read-transcripts', `${HOME}/.claude/projects/none`], null, /no session records/],
  ])('%s → exit 2 on stderr', (_n, argv, stdin, message) => {
    const r = call(fake({}, stdin).deps, ...argv);
    expect(r.code).toBe(EXIT.usage);
    expect(r.out).toEqual([]);
    expect(r.err).toMatch(message);
  });

  it('pasted wording that the claim rules forbid in our own text (safe, a currency amount) does not stop the output', () => {
    const r = call(fake({}, '30%  Switch to safe mode for USD 3 per day · run /compact\n').deps, 'import-usage');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.join('\n')).toContain('Comparisons run on your own Claude account');
  });

  it('outside a git repository → exit 2', () => {
    const { deps } = fake({}, ROWS);
    expect(call({ ...deps, cwd: '/tmp/elsewhere' }, 'import-usage').code).toBe(EXIT.usage);
  });

  it('property: output and store never hold generated secrets, prompt text, absolute paths or identities', () => {
    const token = fc.stringMatching(/^[A-Za-z0-9]{12,18}$/);
    fc.assert(
      fc.property(token, token, fc.stringMatching(/^[a-z]{6,9}$/), (sec, pr, who) => {
        const secret = `ghp_${sec}${sec}`;
        const prompt = `PROMPT ${pr} fix the parser and keep the tests passing`;
        const abs = `/Users/zq${who}/private/${pr}.md`;
        const line = `Always use ${secret} with ${prompt} from ${abs} for every single request here.`;
        const { deps, writes } = fake(
          {
            [`${REPO}/CLAUDE.md`]: `${line}\n`,
            [`${REPO}/.claude/rules/r.md`]: `${line}\nNever use ${secret} with ${prompt} from ${abs} again.\n`,
            [`${REPO}/.claude/skills/zq${who}/SKILL.md`]: `---\nmodel: ${secret}\n---\n${prompt}\n`,
            [`${REPO}/.claude/settings.json`]: JSON.stringify({ env: { TOKEN: secret } }),
            [`${PROJECTS}/s.jsonl`]: SESSION.replace('"r1"', JSON.stringify(`${secret} ${prompt}`)),
          },
          `25%  Trim ${abs} for zq${who} · 49k tokens per request`,
        );
        const r = call({ ...deps, machineIdentities: () => [`zq${who}`] }, 'import-usage', '--read-transcripts', PROJECTS);
        expect(r.code).toBe(EXIT.ok);
        const out = r.out.join('\n');
        for (const x of [secret, prompt, pr, abs, `zq${who}`]) expect(out).not.toContain(x);
        expect(writes).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });
});
