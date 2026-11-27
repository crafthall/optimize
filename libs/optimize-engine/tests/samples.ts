import type { ComparisonInput, ComparisonRecordV1, FixtureInput, FixtureV1, StoreFs } from '../src/index';

export const REPO = '/home/sample-user/work/repo';
export const COMMIT = 'a'.repeat(40);
export const H = (c: string): string => `sha256:${c.repeat(64)}`;

export const fixtureInput = (over: Partial<FixtureInput> = {}): FixtureInput => ({
  name: 'calc-core-rounding',
  createdAt: '2026-11-26T10:15:00Z',
  commit: COMMIT,
  promptText: 'Fix the off-by-one in roundTo and keep the tests green.',
  promptFile: `${REPO}/fixtures/f1.md`,
  repoRoot: REPO,
  check: 'npx nx test calc-core',
  caps: { timeoutMin: 15, maxBudgetUsd: 0.5 },
  oracleTools: [{ name: 'node', version: '24.21.0' }],
  ...over,
});

export const validFixture = (): FixtureV1 => ({
  schemaVersion: '1.0.0',
  kind: 'fixture',
  name: 'calc-core-rounding',
  createdAt: '2026-11-26T10:15:00Z',
  commit: COMMIT,
  promptHash: H('b'),
  promptFile: 'fixtures/f1.md',
  check: 'npx nx test calc-core',
  caps: { timeoutMin: 15, maxBudgetUsd: 0.5 },
  oracleTools: [{ name: 'node', version: '24.21.0' }],
});

const metrics = (cost: number) => ({
  inputTokens: 1200,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 30000,
  cacheReadTokens: 250000,
  outputTokens: 4000,
  totalCostUsd: cost,
  durationApiMs: 61000,
  model: 'claude-opus-5-5',
});

export const comparisonInput = (over: Partial<ComparisonInput> = {}): ComparisonInput => ({
  createdAt: '2026-11-26T10:15:00Z',
  status: 'complete',
  versions: { optimize: '0.0.1', claudeCode: '2.3.1 (Claude Code)', model: 'claude-opus-5-5', effort: 'high' },
  content: { config: 'model: inherit', diff: '--- a/x\n+++ b/x\n', pluginList: 'crafthall-hq@0.1.0' },
  changedFiles: [`${REPO}/.claude/agents/reviewer.md`, 'CLAUDE.md', 'CLAUDE.md', '/elsewhere/outside.md'],
  repoRoot: REPO,
  fixtures: [{ name: 'calc-core-rounding', commit: COMMIT, promptHash: H('b') }],
  arms: [
    { arm: 'baseline', configHash: H('c') },
    { arm: 'changed', configHash: H('d') },
  ],
  plan: { runsPerArm: 12, cv: 0.3, mde: 0.285, expectedCostUsd: 9.36, paybackMonths: 1.2, maxRuns: 60, maxBudgetUsdPerRun: 0.5 },
  runs: [
    { seq: 0, fixture: 'calc-core-rounding', arm: 'baseline', oracleExitCode: 0, metrics: metrics(0.41) },
    { seq: 1, fixture: 'calc-core-rounding', arm: 'changed', oracleExitCode: 0, metrics: metrics(0.22) },
    { seq: 2, fixture: 'calc-core-rounding', arm: 'baseline', oracleExitCode: null, metrics: metrics(0.5) },
  ],
  exclusions: [{ seq: 2, reason: 'budget-cap' }],
  result: { costRatio: 0.54, ci95: [0.41, 0.71], passes: { baseline: { passed: 1, total: 1 }, changed: { passed: 1, total: 1 } } },
  verdict: { code: 'likely-saving', text: 'Likely saving, not proven: cost ratio 0.54 (95% CI 0.41-0.71), 1 task.' },
  ...over,
});

export const validComparison = (): ComparisonRecordV1 => {
  const { createdAt, status, versions, fixtures, arms, plan, runs, exclusions, result, verdict } = comparisonInput();
  return {
    schemaVersion: '1.0.0',
    kind: 'comparison',
    id: '20261126T101500Z-0123abcd',
    ...{ createdAt, status, versions, fixtures, arms, plan, runs, exclusions, result, verdict }, hashes: { config: H('1'), diff: H('2'), pluginList: H('3') }, change: { changedFiles: ['.claude/agents/reviewer.md', 'CLAUDE.md'] } };
};

/** In-memory StoreFs for store and fixture tests. */
export const memoryFs = (): StoreFs & { files: Map<string, string>; dirs: Set<string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readText: (p) => files.get(p),
    writeText: (p, t) => void files.set(p, t),
    mkdirp: (p) => void dirs.add(p),
    list: (d) => [...files.keys()].filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/')).map((p) => p.slice(d.length + 1)),
    remove: (p) => files.delete(p),
  };
};
