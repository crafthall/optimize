// Pure helpers of `fixture add | list | remove` (R0-05). The CLI shell does the I/O (git, files, child
// processes); everything that decides what a fixture holds lives here so a second shell (HQ, later) reuses it.

import type { FixtureV1 } from './records';

/** Defaults of `fixture add` (release r0 §4). */
export const FIXTURE_DEFAULTS = { commit: 'HEAD', timeoutMin: 15, maxBudgetUsd: 0.5 } as const;

/** Schema limits of the caps (record-v1 schema): both exclusive of 0. */
const CAP_MAX = { timeoutMin: 240, maxBudgetUsd: 100 } as const;

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A fixture name is also its file name: lower-case letters, digits and dashes, 1–63 characters. */
export const isFixtureName = (name: string): boolean => NAME.test(name);

/** Parses a cap flag value; null when it is not a plain positive number within the schema limit. */
export function parseCap(value: string | undefined, cap: keyof typeof CAP_MAX): number | null {
  if (value === undefined || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= CAP_MAX[cap] ? n : null;
}

/**
 * Well-known oracle tools whose version is recorded with a fixture (so a later replay can tell a tool upgrade from a
 * regression). Only names on this list are ever run with `--version`; a word of the user's command that is not on it
 * (a script, a path, an alias) is never executed by `fixture add`.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'vitest', 'jest', 'nx',
  'python', 'python3', 'pytest', 'uv', 'go', 'cargo', 'rustc', 'make', 'java', 'mvn', 'gradle', 'dotnet', 'ruby', 'bundle', 'php', 'composer',
]);

/** Tools of the success command to record versions of: the first word of every `&&`, `||`, `;` or `|` segment, known tools only, plus `node`. */
export function oracleToolCandidates(check: string): string[] {
  const out = new Set<string>(['node']);
  for (const segment of check.split(/&&|\|\||[;|]/)) {
    const words = segment.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const first = words[0];
    if (first && KNOWN_TOOLS.has(first)) out.add(first);
  }
  return [...out].sort();
}

/** Version token of a `<tool> --version` output (e.g. "v24.21.0", "Python 3.12.1", "go version go1.22.3 darwin/arm64"); null when none. */
export function parseToolVersion(output: string): string | null {
  const m = /(?:^|[^0-9A-Za-z.])v?(?:go)?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)*)/.exec(output);
  const v = m?.[1]?.slice(0, 64);
  return v && /^[0-9A-Za-z.+_-]{1,64}$/.test(v) ? v : null;
}

export interface FixtureSummary {
  name: string;
  commit: string;
  check: string;
  caps: string;
  createdAt: string;
}

/** One row of `fixture list`: short commit, caps as text. */
export const describeFixture = (f: FixtureV1): FixtureSummary => ({
  name: f.name,
  commit: f.commit.slice(0, 12),
  check: f.check,
  caps: `${f.caps.timeoutMin} min, $${f.caps.maxBudgetUsd.toFixed(2)}`,
  createdAt: f.createdAt,
});
