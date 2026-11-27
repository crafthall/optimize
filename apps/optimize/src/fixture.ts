// `fixture add | list | remove` (R0-05; release r0 §4). A fixture freezes one task: the repo at a pinned
// commit, the prompt file (stored as a salted hash plus its repo-relative path, never its text), the success command
// and the caps. The first output line is the verdict; exit codes as in r0 §4.
import { isAbsolute, resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import {
  createFixture,
  describeFixture,
  ensureSalt,
  findFixtureConfigRisks,
  fixtureConfigWarning,
  hasFixtureConfigRisks,
  FIXTURE_DEFAULTS,
  isFixtureName,
  listFixtures,
  oracleToolCandidates,
  parseCap,
  readFixture,
  RecordPrivacyError,
  RecordSchemaError,
  removeFixture,
  serializeRecord,
  STORE_DIR,
  toRepoRelativePath,
  writeFixture,
  type FixtureV1,
} from '@crafthall/optimize-engine';
import { BIN_NAME } from './brand';
import { EnvironmentError, InterruptedError, type CliDeps } from './deps';

import { EXIT, type Io } from './exit';

export { EXIT, type Io } from './exit';

/** A command handler: arguments after the command path; returns the exit code (`compare` asynchronously). */
export type Handler = (args: readonly string[], io: Io, deps: CliDeps) => number | Promise<number>;

const BIN = BIN_NAME;

export class UsageError extends Error {}

export function parse<O extends ParseArgsOptionsConfig>(args: readonly string[], options: O) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true } as const);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message.replace(/\. To specify a positional argument.*$/s, '') : String(e));
  }
}

/** Runs a handler body and maps the error classes to exit codes; usage errors and refusals go to stderr. */
export function guarded(io: Io, body: () => number): number {
  try {
    return body();
  } catch (e) {
    return exitFor(io, e);
  }
}

/** `guarded` for an async body (`compare`): the same mapping for a rejected promise. */
export async function guardedAsync(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    return exitFor(io, e);
  }
}

/** Exit code of a handler error; any other error is rethrown (a bug: exit 1 in cli.ts main). */
function exitFor(io: Io, e: unknown): number {
  if (e instanceof UsageError) {
    io.err(`${BIN}: ${e.message}`);
    return EXIT.usage;
  }
  if (e instanceof EnvironmentError) {
    io.err(`${BIN}: ${e.message}`);
    return EXIT.environment;
  }
  if (e instanceof InterruptedError) {
    // Outside the run loop (e.g. the replay check): nothing was run or stored; worktrees are removed in finally.
    io.err(`${BIN}: interrupted (${e.signal}); nothing was stored`);
    return EXIT.runCap;
  }
  throw e;
}

export const repoRootOf = (deps: CliDeps): string => {
  const root = deps.findRepoRoot(deps.cwd);
  if (!root) throw new UsageError('not inside a git repository; run this command in the repository the fixture belongs to');
  return root;
};

const oneName = (positionals: string[], usage: string): string => {
  if (positionals.length !== 1) throw new UsageError(`expected one fixture name. Usage: ${BIN} ${usage}`);
  const name = positionals[0]!;
  if (!isFixtureName(name)) throw new UsageError(`invalid fixture name "${name}": use lower-case letters, digits and dashes (max 63)`);
  return name;
};

export const fixtureAdd: Handler = (args, io, deps) =>
  guarded(io, () => {
    const { values, positionals } = parse(args, {
      prompt: { type: 'string' },
      check: { type: 'string' },
      commit: { type: 'string' },
      'timeout-min': { type: 'string' },
      'max-budget-usd': { type: 'string' },
    });
    const usage = 'fixture add <name> --prompt <file> --check "<cmd>" [--commit <sha>] [--timeout-min <n>] [--max-budget-usd <n>]';
    const name = oneName(positionals, usage);
    if (!values.prompt) throw new UsageError(`--prompt <file> is required. Usage: ${BIN} ${usage}`);
    const check = values.check?.trim();
    if (!check) throw new UsageError(`--check "<cmd>" is required: the success command whose exit code is the oracle`);
    if (check.length > 500) throw new UsageError('--check is longer than 500 characters; put the steps in a script in the repo and call it');
    const timeoutMin = values['timeout-min'] === undefined ? FIXTURE_DEFAULTS.timeoutMin : parseCap(values['timeout-min'], 'timeoutMin');
    if (timeoutMin === null) throw new UsageError('--timeout-min must be a number above 0 and at most 240');
    const maxBudgetUsd = values['max-budget-usd'] === undefined ? FIXTURE_DEFAULTS.maxBudgetUsd : parseCap(values['max-budget-usd'], 'maxBudgetUsd');
    if (maxBudgetUsd === null) throw new UsageError('--max-budget-usd must be a number above 0 and at most 100');

    const repoRoot = repoRootOf(deps);
    const rev = values.commit ?? FIXTURE_DEFAULTS.commit;
    const commit = deps.git.resolveCommit(repoRoot, rev);
    if (!commit) throw new UsageError(`unknown commit "${rev}": pin a commit that exists in this repository`);
    const head = deps.git.resolveCommit(repoRoot, 'HEAD');
    if (commit === head && deps.git.isDirty(repoRoot)) {
      io.err(`refused: the working tree has uncommitted changes to tracked files, so commit ${commit.slice(0, 12)} is not what you have now.`);
      io.err('Commit or stash the changes, or pin an earlier commit with --commit <sha>.');
      return EXIT.refused;
    }

    const promptPath = isAbsolute(values.prompt) ? values.prompt : resolve(deps.cwd, values.prompt);
    if (toRepoRelativePath(promptPath, repoRoot) === null) throw new UsageError('the prompt file must be inside the repository (the fixture stores its repo-relative path, never its text)');
    const promptText = deps.readFile(promptPath);
    if (promptText === undefined) throw new UsageError(`prompt file not found: ${values.prompt}`);
    if (!promptText.trim()) throw new UsageError('the prompt file is empty');
    if (readFixture(deps.fs, repoRoot, name).ok) throw new UsageError(`fixture "${name}" already exists; remove it first with \`${BIN} fixture remove ${name}\``);

    const identities = [...deps.machineIdentities(), ...deps.git.identities(repoRoot)];
    const oracleTools = oracleToolCandidates(check).flatMap((tool) => {
      const version = deps.toolVersion(tool, repoRoot);
      return version ? [{ name: tool, version }] : [];
    });
    let fixture: FixtureV1;
    try {
      const salt = ensureSalt(deps.fs, repoRoot, deps.randomHex);
      fixture = createFixture(
        { name, createdAt: deps.now().toISOString(), commit, promptText, promptFile: promptPath, repoRoot, check, caps: { timeoutMin, maxBudgetUsd }, oracleTools, salt },
        { identities },
      );
      writeFixture(deps.fs, repoRoot, fixture, { identities });
    } catch (e) {
      if (e instanceof RecordPrivacyError || e instanceof RecordSchemaError) throw new UsageError(`fixture not stored: ${e.message}`);
      throw e;
    }

    io.out(`fixture "${name}" added: commit ${commit.slice(0, 12)}, prompt stored as a salted hash only`);
    io.out(`  check:        ${fixture.check}`);
    io.out(`  prompt file:  ${fixture.promptFile}`);
    io.out(`  caps:         ${describeFixture(fixture).caps} per run`);
    io.out(`  oracle tools: ${fixture.oracleTools.map((t) => `${t.name} ${t.version}`).join(', ') || 'none detected'}`);
    io.out(`  stored in:    ${STORE_DIR}/fixtures/${name}.json (local, git-ignored)`);
    // R0-13: hooks and MCP servers the repo would run in a non-bare `claude -p` session.
    const risks = findFixtureConfigRisks((rel) => deps.readFile(`${repoRoot}/${rel}`));
    if (hasFixtureConfigRisks(risks)) for (const l of fixtureConfigWarning(risks, BIN)) io.err(l);
    return EXIT.ok;
  });

export const fixtureList: Handler = (args, io, deps) =>
  guarded(io, () => {
    const { values, positionals } = parse(args, { json: { type: 'boolean' } });
    if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}". Usage: ${BIN} fixture list [--json]`);
    const repoRoot = repoRootOf(deps);
    const fixtures: FixtureV1[] = [];
    for (const name of listFixtures(deps.fs, repoRoot)) {
      const r = readFixture(deps.fs, repoRoot, name);
      if (r.ok) fixtures.push(r.record);
      else io.err(`warning: skipped ${STORE_DIR}/fixtures/${name}.json: ${r.errors.map((x) => `${x.path || '/'} ${x.message}`).join('; ')}`);
    }
    if (values.json) {
      io.out(JSON.stringify(fixtures, null, 2));
      return EXIT.ok;
    }
    if (!fixtures.length) {
      io.out(`no fixtures yet – add one with \`${BIN} fixture add <name> --prompt <file> --check "<cmd>"\``);
      return EXIT.ok;
    }
    io.out(`${fixtures.length} fixture${fixtures.length === 1 ? '' : 's'}`);
    const rows = fixtures.map(describeFixture).map((s) => [s.name, s.commit, s.caps, s.check]);
    const table = [['NAME', 'COMMIT', 'CAPS', 'CHECK'], ...rows];
    const widths = [0, 1, 2].map((i) => Math.max(...table.map((r) => r[i]!.length)));
    for (const r of table) io.out(`  ${r.map((c, i) => (i < 3 ? c.padEnd(widths[i]!) : c)).join('  ')}`);
    return EXIT.ok;
  });

export const fixtureRemove: Handler = (args, io, deps) =>
  guarded(io, () => {
    const { values, positionals } = parse(args, { json: { type: 'boolean' } });
    const name = oneName(positionals, 'fixture remove <name> [--json]');
    const repoRoot = repoRootOf(deps);
    const existing = readFixture(deps.fs, repoRoot, name);
    if (!existing.ok && !listFixtures(deps.fs, repoRoot).includes(name)) throw new UsageError(`no fixture named "${name}"; see \`${BIN} fixture list\``);
    removeFixture(deps.fs, repoRoot, name);
    if (values.json && existing.ok) io.out(serializeRecord(existing.record).trimEnd());
    else io.out(`fixture "${name}" removed`);
    return EXIT.ok;
  });

