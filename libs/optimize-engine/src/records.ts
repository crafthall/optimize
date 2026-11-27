// Typed record builders and the parse/serialize pair of the local store. Every record the engine hands out has passed
// the schema (validate.ts) and the privacy guard (privacy.ts); a builder takes raw inputs (prompt text, user-given
// paths) and keeps only what a record may hold (hashes, repo-relative paths).

import { contentHash } from './hash';
import { findPrivacyLeaks, toRepoRelativePath, type PrivacyContext, type PrivacyLeak } from './privacy';
import type { CostLabels } from './labels';
import { SCHEMA_VERSION } from './schema';
import { formatErrors, validateRecord, type SchemaError } from './validate';

export type Hash = string;
export type Arm = 'baseline' | 'changed';

export interface FixtureV1 {
  schemaVersion: string;
  kind: 'fixture';
  name: string;
  createdAt: string;
  commit: string;
  promptHash: Hash;
  promptFile?: string;
  check: string;
  caps: { timeoutMin: number; maxBudgetUsd: number };
  oracleTools: { name: string; version: string }[];
}

export interface RunMetricsV1 {
  inputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  durationApiMs: number;
  model: string;
  /**
   * Tokens of the run summed over every model of `modelUsage` (since schema 1.5.0): input, cache write (5m + 1h;
   * `cacheCreationInputTokens`), cache read, output. The `tokens` metric of `compare` uses it; absent in older records,
   * where the top-level usage fields above stand in (`runTokens`, compare.ts).
   */
  modelUsageTokens?: ModelUsageTokens;
}

/** Token components of one run summed over `modelUsage`. */
export interface ModelUsageTokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** What the verdict of a comparison measures: token use or API-equivalent cost. Absent in a record → `cost`. */
export type Metric = 'tokens' | 'cost';
export const METRICS: readonly Metric[] = ['tokens', 'cost'];

/** How `compare` authenticates its `claude -p` runs (R0-12): the user's own API key (default) or their own login. */
export type AuthMode = 'api-key' | 'subscription';

/** Why a comparison stopped before its plan completed. */
export type StopReason = 'run-cap' | 'claude-code-version' | 'interrupted' | 'error';

export interface ComparisonRecordV1 {
  schemaVersion: string;
  kind: 'comparison';
  id: string;
  createdAt: string;
  status: 'complete' | 'incomplete';
  /**
   * Why an incomplete record stopped (since schema 1.4.0); absent in complete and older records. `interrupted`
   * (the user's Ctrl-C or kill) caps the verdict at "likely saving" (`capVerdictForStop`).
   */
  stop?: StopReason;
  /**
   * What the verdict measures (since schema 1.5.0): `tokens` (token use per run) or `cost` (`total_cost_usd`).
   * Absent in older records, which are read as `cost`. `result.costRatio` and `result.ci95` hold the ratio of this metric.
   */
  metric?: Metric;
  /** Auth mode of the runs (since schema 1.1.0); absent in 1.0.0 records. */
  auth?: AuthMode;
  /** Cost labels of the figures (since schema 1.2.0): billing mode at compare time and the label codes. */
  labels?: CostLabels;
  /**
   * `model`: the baseline arm's pinned model (the changed arm's when the baseline has none). `modelByArm` (since
   * schema 1.3.0): the model each arm pinned from its first counted run; absent in older records.
   */
  versions: { optimize: string; claudeCode: string; model: string; effort?: string; modelByArm?: Partial<Record<Arm, string>> };
  hashes: { config: Hash; diff: Hash; pluginList: Hash };
  change: { changedFiles: string[] };
  fixtures: { name: string; commit: string; promptHash: Hash }[];
  arms: { arm: Arm; configHash: Hash }[];
  plan: { runsPerArm: number; cv: number; mde: number; expectedCostUsd: number; paybackMonths?: number | null; maxRuns: number; maxBudgetUsdPerRun: number };
  runs: { seq: number; fixture: string; arm: Arm; oracleExitCode: number | null; metrics: RunMetricsV1 }[];
  exclusions: { seq: number; reason: 'model-fallback' | 'run-error' | 'timeout' | 'budget-cap' }[];
  result: { costRatio: number | null; ci95: [number, number] | null; passes: Record<Arm, { passed: number; total: number }> };
  verdict: { code: 'measured-saving' | 'likely-saving' | 'not-enough-evidence'; text: string };
}

export type OptimizeRecord = FixtureV1 | ComparisonRecordV1;

/** A record failed the schema (exit code 2 in the CLI). */
export class RecordSchemaError extends Error {
  constructor(readonly errors: readonly SchemaError[]) {
    super(`record does not match schema v${SCHEMA_VERSION}: ${formatErrors(errors)}`);
    this.name = 'RecordSchemaError';
  }
}

/** A record would store private data; the message names the field and the kind, never the value. */
export class RecordPrivacyError extends Error {
  constructor(readonly leaks: readonly PrivacyLeak[]) {
    super(`record would store private data: ${leaks.map((l) => `${l.path || '/'} (${l.kind})`).join(', ')}`);
    this.name = 'RecordPrivacyError';
  }
}

/** Throws RecordSchemaError or RecordPrivacyError; returns the record typed. The one gate every write passes. */
export function assertStorable<T extends OptimizeRecord>(record: T, context: PrivacyContext = {}): T {
  const errors = validateRecord(record);
  if (errors.length) throw new RecordSchemaError(errors);
  const leaks = findPrivacyLeaks(record, context);
  if (leaks.length) throw new RecordPrivacyError(leaks);
  return record;
}

export interface FixtureInput {
  name: string;
  /** UTC timestamp; the caller passes the clock so the builder stays pure. */
  createdAt: string;
  commit: string;
  /** The prompt text: hashed here, never stored. */
  promptText: string;
  /** Path of the prompt file as the user gave it; stored repo-relative, or dropped when outside the repo. */
  promptFile?: string;
  repoRoot: string;
  check: string;
  caps: { timeoutMin: number; maxBudgetUsd: number };
  oracleTools?: { name: string; version: string }[];
  /** Per-store salt (kept in the local store, never in a record). */
  salt?: string;
}

/** Builds a fixture record: prompt text → hash, prompt path → repo-relative. Throws on schema or privacy errors. */
export function createFixture(input: FixtureInput, context: PrivacyContext = {}): FixtureV1 {
  const promptFile = input.promptFile === undefined ? undefined : toRepoRelativePath(input.promptFile, input.repoRoot);
  const fixture: FixtureV1 = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'fixture',
    name: input.name,
    createdAt: input.createdAt,
    commit: input.commit,
    promptHash: contentHash(input.promptText, input.salt),
    ...(promptFile ? { promptFile } : {}),
    check: input.check,
    caps: { timeoutMin: input.caps.timeoutMin, maxBudgetUsd: input.caps.maxBudgetUsd },
    oracleTools: (input.oracleTools ?? []).map((t) => ({ name: t.name, version: t.version })),
  };
  return assertStorable(fixture, context);
}

export interface ComparisonInput extends Omit<ComparisonRecordV1, 'schemaVersion' | 'kind' | 'id' | 'hashes' | 'change'> {
  /** Raw content that is hashed here and never stored. */
  content: { config: string; diff: string; pluginList: string };
  /** Paths the change touches as the diff names them (absolute or repo-relative). */
  changedFiles: readonly string[];
  repoRoot: string;
  salt?: string;
}

/** Record id: UTC start time (compact ISO) plus 8 hex of the diff hash, e.g. 20261126T101500Z-1a2b3c4d. */
export const comparisonId = (createdAt: string, diffHash: Hash): string =>
  `${createdAt.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}-${diffHash.slice(diffHash.indexOf(':') + 1, diffHash.indexOf(':') + 9)}`;

/** Builds a comparison record: content → hashes, changed files → sorted unique repo-relative paths. */
export function createComparisonRecord(input: ComparisonInput, context: PrivacyContext = {}): ComparisonRecordV1 {
  const { content, changedFiles: rawChanged, repoRoot, salt, ...rest } = input;
  const hashes = {
    config: contentHash(content.config, salt),
    diff: contentHash(content.diff, salt),
    pluginList: contentHash(content.pluginList, salt),
  };
  const changedFiles = [...new Set(rawChanged.map((p) => toRepoRelativePath(p, repoRoot)).filter((p): p is string => p !== null))].sort();
  const record: ComparisonRecordV1 = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'comparison',
    id: comparisonId(input.createdAt, hashes.diff),
    ...rest,
    hashes,
    change: { changedFiles },
  };
  return assertStorable(record, context);
}

export type ParseResult<T> = { ok: true; record: T } | { ok: false; errors: SchemaError[] };

/** Parses stored JSON text into a validated record. Never throws. */
export function parseRecord(text: string): ParseResult<OptimizeRecord> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ path: '', message: 'not valid JSON' }] };
  }
  const errors = validateRecord(value);
  if (errors.length) return { ok: false, errors };
  const newer = newerMinor((value as OptimizeRecord).schemaVersion);
  if (newer) return { ok: false, errors: [{ path: '/schemaVersion', message: newer }] };
  return { ok: true, record: value as OptimizeRecord };
}

/**
 * ADR-0001 read rule: the engine reads records of its own major with a minor up to its own. A newer minor may carry
 * a field this engine does not know (and so cannot check for private data), so it is refused with a hint. Returns
 * the reason, or null when the version is readable.
 */
export function newerMinor(version: string): string | null {
  const [major, minor] = version.split('.').map(Number);
  const [ownMajor, ownMinor] = SCHEMA_VERSION.split('.').map(Number);
  if (major !== ownMajor || minor! > ownMinor!)
    return `written with record schema ${version}; this version of Crafthall Optimize reads ${ownMajor}.0 to ${ownMajor}.${ownMinor} – update it to read this record`;
  return null;
}

/** Stable JSON text of a record (two-space indent, trailing newline). */
export const serializeRecord = (record: OptimizeRecord): string => `${JSON.stringify(record, null, 2)}\n`;
