// `compare` and `report` (R0-06, R0-07, R0-08; release r0 §4; validation §4). `compare` runs the user's
// fixtures before and after one change (a patch file), interleaved A/B/A/B per task, every run cold in a fresh
// worktree, and writes one comparison record. Spending guard: the plan block comes first, then payback refusal
// (exit 3 without --force), then the confirmation (no terminal and no --yes: exit 3), and the run cap (exit 5).
import { isAbsolute, join, resolve } from 'node:path';
import {
  analyzeRuns,
  COMPARE_DEFAULTS,
  contentHash,
  createComparisonRecord,
  costLabels,
  withModelChange,
  defaultMetric,
  METRICS,
  describeFixtureConfigRisks,
  ensureSalt,
  findFixtureConfigRisks,
  hasFixtureConfigRisks,
  formatPlan,
  formatReport,
  isFixtureName,
  isModelFallback,
  modelPinKeyFor,
  plannedModelMatcher,
  listFixtures,
  parseClaudeJson,
  parseRecord,
  planComparison,
  readComparison,
  readFixture,
  RecordPrivacyError,
  redactRecord,
  RecordSchemaError,
  runSchedule,
  seedFromHash,
  serializeRecord,
  STORE_DIR,
  writeComparison,
  type Arm,
  type AuthMode,
  type ComparisonRecordV1,
  type FixtureV1,
  type Metric,
  type ModelByArm,
  type StopReason,
} from '@crafthall/optimize-engine';
import { resolveBilling } from './billing';
import { BIN_NAME, CLI_VERSION } from './brand';
import { EnvironmentError, InterruptedError, type CliDeps } from './deps';
import { EXIT } from './exit';
import { guarded, guardedAsync, parse, repoRootOf, UsageError, type Handler } from './fixture';

/** Auth modes of `compare --auth` (R0-12, legal note §3); the first is the default. */
export const AUTH_MODES: readonly AuthMode[] = ['api-key', 'subscription'];
export const API_KEY_ENV = 'ANTHROPIC_API_KEY';
/** Printed before the plan block in subscription mode (legal note §3 finding 1, mitigation b). */
export const SUBSCRIPTION_NOTICE = "Runs count against your plan's limits; Anthropic's plan limits assume ordinary, individual use.";
/** Printed in subscription mode when ANTHROPIC_API_KEY is also set (presence check only). */
export const KEY_SET_IN_SUBSCRIPTION = `Warning: ${API_KEY_ENV} is set in your environment. A \`claude -p\` run always uses that key when it is set, so these runs would be billed to that key's API account, not counted against your Claude plan. Unset it for these runs to use your Claude login, or use --auth api-key.`;
/**
 * Lead decision on the legal review: with the key set, subscription-labelled figures would describe runs the
 * API account pays for (legal note §2.2 item 2), so a spending run refuses (exit 3) before the plan and any run.
 */
export const KEY_SET_REFUSAL = `${KEY_SET_IN_SUBSCRIPTION} Refused: unset the key or use --auth api-key.`;

/**
 * The argv of one `claude -p` run – the one place that builds it. `api-key` (default) adds `--bare`: Claude Code then
 * authenticates only with the user's own ANTHROPIC_API_KEY and skips the repo's hooks and MCP servers.
 * `subscription` drops `--bare`, so the user's own login is used. The prompt goes on stdin, never in argv.
 */
export function claudeArgs(opts: { maxBudgetUsd: number; auth?: AuthMode }): string[] {
  return [...(opts.auth === 'subscription' ? [] : ['--bare']), '-p', '--output-format', 'json', '--max-budget-usd', String(opts.maxBudgetUsd)];
}

/**
 * Auth check of a spending run (exit 4 via EnvironmentError). api-key mode needs ANTHROPIC_API_KEY to be present –
 * checked by presence only, its value is never read. Subscription mode needs nothing from Optimize: the unmodified
 * `claude` uses the user's own login; Optimize never offers a login and never touches stored credentials.
 */
export function assertAuth(auth: AuthMode, hasEnv: (name: string) => boolean): void {
  if (auth === 'api-key' && !hasEnv(API_KEY_ENV))
    throw new EnvironmentError(
      `--auth api-key (the default) needs your own ${API_KEY_ENV} in the environment; set it in your shell and retry, or choose your own Claude login explicitly with --auth subscription`,
    );
}

/** Repo-relative paths a unified diff touches (`+++ b/…` and `--- a/…` lines, /dev/null skipped). */
export function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\s*$/gm)) if (m[1] !== '/dev/null') out.add(m[1]!);
  return [...out];
}

const num = (raw: string | undefined, flag: string, ok: (n: number) => boolean, what: string): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || !ok(n)) throw new UsageError(`${flag} must be ${what}`);
  return n;
};

const CONFIG_FILES = ['.claude/settings.json', '.mcp.json'];

/** The `model` of `.claude/settings.json` in `dir`, or null when it is not set there (plan line). */
export function configuredModel(deps: CliDeps, dir: string): string | null {
  try {
    const m = JSON.parse(deps.readFile(join(dir, '.claude/settings.json')) ?? '{}')?.model;
    return typeof m === 'string' && /^[0-9A-Za-z.:@_[\]-]{1,128}$/.test(m) ? m : null;
  } catch {
    return null;
  }
}

/** One configured model per arm for the plan: null when no fixture sets one, else the distinct values joined. */
const armModel = (set: ReadonlySet<string | null>): string | null =>
  set.size === 1 && set.has(null) ? null : [...set].map((m) => m ?? 'your Claude Code default').join(' / ') || null;

function configOf(deps: CliDeps, dir: string): { config: string; pluginList: string } {
  const files = CONFIG_FILES.map((f) => `${f}\n${deps.readFile(join(dir, f)) ?? ''}`);
  let plugins = '';
  try {
    plugins = JSON.stringify(JSON.parse(deps.readFile(join(dir, '.claude/settings.json')) ?? '{}')?.enabledPlugins ?? {});
  } catch {
    plugins = '';
  }
  return { config: files.join('\n'), pluginList: plugins };
}

/** Lets a pending signal handler run (it fires in the poll phase; `setImmediate` runs right after it). */
const yieldToSignals = (): Promise<void> => new Promise((done) => setImmediate(done));

export const compare: Handler = (args, io, deps) =>
  guardedAsync(io, async () => {
    const { values, positionals } = parse(args, {
      change: { type: 'string' },
      fixtures: { type: 'string' },
      'runs-per-arm': { type: 'string' },
      cv: { type: 'string' },
      'monthly-volume': { type: 'string' },
      'max-budget-usd': { type: 'string' },
      'max-runs': { type: 'string' },
      auth: { type: 'string' },
      metric: { type: 'string' },
      'plan-only': { type: 'boolean' },
      yes: { type: 'boolean' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      'trust-fixture-config': { type: 'boolean' },
    });
    if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"; the change is given with --change <patch-file>`);
    if (!values.change) throw new UsageError('--change <patch-file> is required: one diff, the only difference between the two arms');
    const runsPerTask = num(values['runs-per-arm'], '--runs-per-arm', (n) => Number.isInteger(n) && n >= 1 && n <= 1000, 'a whole number from 1 to 1000') ?? COMPARE_DEFAULTS.runsPerTask;
    const cv = num(values.cv, '--cv', (n) => n > 0 && n <= 10, 'a number above 0 and at most 10') ?? null;
    const monthlyVolume = num(values['monthly-volume'], '--monthly-volume', (n) => n > 0, 'a positive amount in USD per month') ?? null;
    const budgetFlag = num(values['max-budget-usd'], '--max-budget-usd', (n) => n > 0 && n <= 100, 'a number above 0 and at most 100');
    const maxRuns = num(values['max-runs'], '--max-runs', (n) => Number.isInteger(n) && n >= 2 && n <= 10000, 'a whole number from 2 to 10000 (at least one run per arm)') ?? COMPARE_DEFAULTS.maxRuns;
    const auth = (values.auth ?? 'api-key') as AuthMode;
    if (!AUTH_MODES.includes(auth)) throw new UsageError(`--auth must be one of ${AUTH_MODES.join(', ')} (default api-key)`);
    //: what the verdict measures; default from the billing mode (tokens for subscription and credits, else cost).
    if (values.metric !== undefined && !METRICS.includes(values.metric as Metric))
      throw new UsageError(`--metric must be one of ${METRICS.join(', ')} (default tokens for subscription or credits billing, cost for api billing or an unset mode)`);
    // With --json, stdout carries only JSON; the human lines go to stderr.
    const say = values.json ? io.err : io.out;

    const repoRoot = repoRootOf(deps);
    const patchPath = isAbsolute(values.change) ? values.change : resolve(deps.cwd, values.change);
    const patch = deps.readFile(patchPath);
    if (patch === undefined) throw new UsageError(`patch file not found: ${values.change}`);
    const changedFiles = patchFiles(patch);
    if (!patch.trim() || !changedFiles.length) throw new UsageError('the patch file holds no diff (expected `git diff` output)');

    const names = values.fixtures ? values.fixtures.split(',').map((s) => s.trim()).filter(Boolean) : listFixtures(deps.fs, repoRoot);
    if (!names.length) throw new UsageError(`no fixtures; add one with \`${BIN_NAME} fixture add <name> --prompt <file> --check "<cmd>"\``);
    const fixtures: FixtureV1[] = names.map((name) => {
      if (!isFixtureName(name)) throw new UsageError(`invalid fixture name "${name}"`);
      const r = readFixture(deps.fs, repoRoot, name);
      if (!r.ok) throw new UsageError(`no usable fixture "${name}" in ${STORE_DIR}/fixtures (${r.errors.map((e) => e.message).join('; ')})`);
      return r.record;
    });
    const budgetOf = (f: FixtureV1): number => budgetFlag ?? f.caps.maxBudgetUsd;

    const version = deps.runner.claudeVersion();
    if (!version) throw new EnvironmentError('`claude` was not found on PATH; install Claude Code and retry');
    // A spending run fails here, before the replay, the plan and the confirmation; --plan-only spends nothing and
    // needs no auth. The untrusted hook/MCP refusal of subscription mode follows the replay check.
    if (!values['plan-only']) assertAuth(auth, (name) => deps.hasEnv(name));
    if (!values['plan-only'] && auth === 'subscription' && deps.hasEnv(API_KEY_ENV)) {
      io.err(KEY_SET_REFUSAL);
      return EXIT.refused;
    }

    // Replay check (spends nothing): each fixture's pinned commit in a fresh worktree, the prompt file still matches
    // its stored hash, and the patch applies there.
    const salt = ensureSalt(deps.fs, repoRoot, deps.randomHex);
    const prompts = new Map<string, string>();
    const risky: string[] = [];
    const configured: Record<Arm, Set<string | null>> = { baseline: new Set(), changed: new Set() };
    // The configured model of each arm of each fixture: it anchors that (arm, fixture)'s model pin.
    const configuredByFixture = new Map<string, Record<Arm, string | null>>();
    for (const f of fixtures) {
      const dir = deps.worktrees.add(repoRoot, f.commit);
      try {
        // R0-13: hooks and MCP servers at the pinned commit – what a non-bare run would start.
        const risks = findFixtureConfigRisks((rel) => deps.readFile(join(dir, rel)));
        if (hasFixtureConfigRisks(risks)) risky.push(`fixture "${f.name}": ${describeFixtureConfigRisks(risks).join('; ')}`);
        const text = f.promptFile ? deps.readFile(join(dir, f.promptFile)) : undefined;
        if (text === undefined || contentHash(text, salt) !== f.promptHash) throw new UsageError(`fixture "${f.name}": the prompt file at commit ${f.commit.slice(0, 12)} no longer matches its stored hash; add the fixture again`);
        if (!deps.worktrees.apply(dir, patch, true)) throw new UsageError(`the patch does not apply at fixture "${f.name}" (commit ${f.commit.slice(0, 12)})`);
        // Model per arm for the plan: the setting at the commit, then with the patch applied (this worktree is
        // removed right after, so applying here changes nothing the runs see).
        const own = { baseline: configuredModel(deps, dir), changed: deps.worktrees.apply(dir, patch) ? configuredModel(deps, dir) : null };
        configured.baseline.add(own.baseline);
        configured.changed.add(own.changed);
        configuredByFixture.set(f.name, own);
        prompts.set(f.name, text);
      } finally {
        deps.worktrees.remove(repoRoot, dir);
      }
    }

    // Untrusted fixture config (R0-13, legal note §3 item 3). api-key mode runs with --bare, which skips hooks and MCP
    // servers; subscription mode does not, so a spending run refuses (exit 3) unless the user trusts the config.
    if (risky.length) {
      const list = risky.map((r) => `  - ${r}`);
      if (auth === 'api-key') io.err(`Fixture config: hooks or MCP servers found; --auth api-key runs use --bare, which does not start them. --bare is not a sandbox: the fixture's check command still runs this repository's code, and its settings \`env\` block still applies.\n${list.join('\n')}`);
      else if (values['trust-fixture-config']) io.err(`Fixture config: you passed --trust-fixture-config, so these hooks and MCP servers run in every run:\n${list.join('\n')}`);
      else {
        const why = `this fixture repository configures hooks or MCP servers, and --auth subscription runs without --bare, so they would run with no trust dialog:\n${list.join('\n')}\nUse --auth api-key (runs with --bare), or pass --trust-fixture-config if you trust this code.`;
        if (!values['plan-only']) {
          io.err(`refused: ${why}`);
          return EXIT.refused;
        }
        io.err(`Note: a spending run would be refused: ${why}`);
      }
    }

    // Billing mode (R0-10): stored, or asked once now; it labels every cost figure from the plan block on (R0-11).
    const billing = resolveBilling(deps, repoRoot, io.err);
    const labels = costLabels(auth, billing);
    const metric: Metric = (values.metric as Metric | undefined) ?? defaultMetric(billing);
    const plan = planComparison({ fixtures: fixtures.map((f) => ({ name: f.name, maxBudgetUsd: budgetOf(f) })), runsPerTask, cv, maxRuns, monthlyVolume });
    // The plan is shown before anything is spent. In a spending run it goes to stderr, so stdout starts with the
    // verdict (r0 §4 output rules); with --plan-only it is the output.
    const planOut = values['plan-only'] && !values.json ? io.out : io.err;
    if (auth === 'subscription') {
      planOut(`Auth: your own Claude login (--auth subscription). ${SUBSCRIPTION_NOTICE}`);
      if (deps.hasEnv(API_KEY_ENV)) planOut(KEY_SET_IN_SUBSCRIPTION);
    }
    const configuredModels = { baseline: armModel(configured.baseline), changed: armModel(configured.changed) };
    for (const l of formatPlan(plan, { fixtures: fixtures.length, runsPerTask, maxRuns, labels, configuredModels, metric })) planOut(l);
    if (values['plan-only']) {
      // A non-record output (r0 §4): nothing is stored, so it has its own kind and format, outside the record schema.
      if (values.json) io.out(JSON.stringify({ kind: 'crafthall-optimize/plan', format: 1, plan }, null, 2));
      say('Plan only: nothing was run and nothing was spent.');
      return EXIT.ok;
    }
    if (plan.refusal && !values.force) {
      io.err(`refused: ${plan.refusal}`);
      return EXIT.refused;
    }
    if (!values.yes) {
      const answer = deps.confirm('Proceed? (y/N) ');
      if (answer === null) {
        io.err('refused: no terminal to confirm the spending; re-run with --yes');
        return EXIT.refused;
      }
      if (!answer) {
        io.err('refused: you declined; nothing was run');
        return EXIT.refused;
      }
    }

    // Runs.
    const identities = [...deps.machineIdentities(), ...deps.git.identities(repoRoot)];
    const createdAt = deps.now().toISOString().replace(/\.\d+Z$/, 'Z');
    const schedule = runSchedule(fixtures.map((f) => f.name), runsPerTask);
    const byName = new Map(fixtures.map((f) => [f.name, f]));
    const runs: ComparisonRecordV1['runs'] = [];
    const exclusions: ComparisonRecordV1['exclusions'] = [];
    const armConfig: Partial<Record<Arm, { config: string; pluginList: string }>> = {};
    // Model pin per (arm, configured model): fixtures of an arm with the same configured model (or none)
    // share one pin, a differently configured fixture gets its own (isModelFallback, modelPinKeyFor, engine), anchored
    // by that configured model when it is readable (stats review §11 ruling 1). `modelByArm` (record) keeps the model
    // of each arm's first counted run.
    const pins: Record<string, string> = {};
    const modelByArm: ModelByArm = {};
    const configuredOf = (arm: Arm, fixture: string): string | null => configuredByFixture.get(fixture)?.[arm] ?? null;
    let stop: StopReason | null = null;
    let interruptSignal = '';
    let failure: unknown = null;
    // Ctrl-C, or SIGINT/SIGTERM sent to this process alone, ends the running child (InterruptedError); the loop
    // stops scheduling, the run's worktree is removed below, the interrupted run is neither stored nor counted, and the
    // runs done so far are written as an incomplete record (exit 5, r0 §4) whose verdict is at most "likely saving".
    // Any other error once a run has completed (e.g. git timing out on a busy machine) takes the same path and
    // exits with its own code; before the first completed run it is rethrown.
    const release = deps.trapInterrupts?.() ?? (() => undefined);
    const pendingInterrupt = async (): Promise<void> => {
      await yieldToSignals();
      const signal = deps.interrupted?.() ?? null;
      if (signal) throw new InterruptedError(signal);
    };
    try {
      for (const [seq, step] of schedule.entries()) {
        await pendingInterrupt();
        if (seq >= maxRuns) {
          stop = 'run-cap';
          break;
        }
        if (seq > 0 && deps.runner.claudeVersion() !== version) {
          stop = 'claude-code-version';
          break;
        }
        const f = byName.get(step.fixture)!;
        const dir = deps.worktrees.add(repoRoot, f.commit);
        // The run's own error names the cause; a removal error counts only when the run itself succeeded.
        let runError: unknown = null;
        try {
          await (async () => {
            if (step.arm === 'changed' && !deps.worktrees.apply(dir, patch)) throw new UsageError(`the patch did not apply in a fresh worktree of "${f.name}"`);
            armConfig[step.arm] ??= configOf(deps, dir);
            const timeoutMs = f.caps.timeoutMin * 60_000;
            const r = await deps.runner.claude(claudeArgs({ maxBudgetUsd: budgetOf(f), auth }), { cwd: dir, input: prompts.get(f.name)!, timeoutMs });
            if (r.notFound) throw new EnvironmentError('`claude` disappeared from PATH during the comparison');
            if (r.timedOut) {
              exclusions.push({ seq, reason: 'timeout' });
              return;
            }
            const parsed = parseClaudeJson(r.stdout);
            if (!parsed) {
              exclusions.push({ seq, reason: 'run-error' });
              return;
            }
            const budgetHit = parsed.subtype === 'error_max_budget_usd';
            const oracleExitCode = parsed.isError ? null : await deps.runner.check(f.check, { cwd: dir, timeoutMs });
            runs.push({ seq, fixture: f.name, arm: step.arm, oracleExitCode: budgetHit ? null : oracleExitCode, metrics: parsed.metrics });
            // Exclusion rule: a run error never pins a model; a counted run is a fallback only against its
            // own pin group (its arm and its fixture's configured model).
            if (parsed.isError && !budgetHit) exclusions.push({ seq, reason: 'run-error' });
            else if (isModelFallback(pins, modelPinKeyFor(step.arm, configuredOf(step.arm, f.name)), parsed.metrics.model, plannedModelMatcher(configuredOf(step.arm, f.name)))) exclusions.push({ seq, reason: 'model-fallback' });
            else modelByArm[step.arm] ??= parsed.metrics.model;
          })();
        } catch (e) {
          runError = e;
        }
        try {
          deps.worktrees.remove(repoRoot, dir);
        } catch (e) {
          runError ??= e;
        }
        if (runError !== null) throw runError;
      }
    } catch (e) {
      if (e instanceof InterruptedError) {
        stop = 'interrupted';
        interruptSignal = e.signal;
      } else if (completedRuns(runs, exclusions) > 0) {
        stop = 'error';
        failure = e;
      } else throw e;
    } finally {
      release();
    }

    const status = stop ? 'incomplete' : 'complete';
    const empty = { config: '', pluginList: '' };
    const base = armConfig.baseline ?? empty;
    const changedCfg = armConfig.changed ?? empty;
    const diffHash = contentHash(patch, salt);
    const analysis = analyzeRuns(runs, exclusions, { seed: seedFromHash(diffHash), status, ...(stop ? { stop } : {}), metric });
    let record: ComparisonRecordV1;
    try {
      record = createComparisonRecord(
        {
          createdAt,
          status,
          ...(stop ? { stop } : {}),
          metric,
          auth,
          // L6 (legal note §8.8): the plan block's labels plus the arms' resolved models – different models on plan or
          // credits billing store the saving as an API-equivalent estimate.
          labels: withModelChange(labels, modelByArm),
          versions: { optimize: CLI_VERSION, claudeCode: version.slice(0, 64), model: modelByArm.baseline ?? modelByArm.changed ?? 'unknown', modelByArm },
          content: { config: base.config, diff: patch, pluginList: base.pluginList },
          changedFiles,
          repoRoot,
          salt,
          fixtures: fixtures.map((f) => ({ name: f.name, commit: f.commit, promptHash: f.promptHash })),
          arms: [
            { arm: 'baseline', configHash: contentHash(base.config, salt) },
            { arm: 'changed', configHash: contentHash(changedCfg.config, salt) },
          ],
          plan: { runsPerArm: plan.nPerArm, cv: plan.cv, mde: plan.mde, expectedCostUsd: plan.expectedCostUsd, paybackMonths: plan.paybackMonths, maxRuns, maxBudgetUsdPerRun: Math.max(...fixtures.map(budgetOf)) },
          runs,
          exclusions,
          ...analysis,
        },
        { identities },
      );
      writeComparison(deps.fs, repoRoot, record, { identities });
    } catch (e) {
      if (e instanceof RecordPrivacyError || e instanceof RecordSchemaError) {
        io.err(`${BIN_NAME}: comparison record not stored: ${e.message}`);
        return EXIT.internal;
      }
      throw e;
    }

    if (values.json) io.out(serializeRecord(record).trimEnd());
    else for (const l of formatReport(record)) io.out(l);
    io.err(`Record: ${STORE_DIR}/records/${record.id}.json (local, git-ignored)`);
    if (stop === 'claude-code-version') {
      io.err('stopped: Claude Code changed version during the comparison; the record is marked incomplete. Restart the comparison.');
      return EXIT.environment;
    }
    if (stop === 'error') {
      const done = completedRuns(runs, exclusions);
      const cause = failure instanceof Error ? failure.message : String(failure);
      io.err(`stopped: ${cause}; ${done} ${done === 1 ? 'run' : 'runs'} completed, recorded in ${STORE_DIR}/records/${record.id}.json (incomplete). Every run worktree was removed.`);
      if (failure instanceof UsageError) return EXIT.usage;
      if (failure instanceof EnvironmentError) return EXIT.environment;
      return EXIT.internal;
    }
    if (stop === 'interrupted') {
      io.err(`stopped: interrupted (${interruptSignal}); the runs done so far are stored as an incomplete record (verdict at most "likely saving") and every run worktree was removed.`);
      return EXIT.runCap;
    }
    if (stop === 'run-cap') {
      io.err(`stopped: the run cap (--max-runs ${maxRuns}) was reached before the plan completed; the record is marked incomplete.`);
      return EXIT.runCap;
    }
    return EXIT.ok;
  });

/** Runs that finished (counted or excluded): distinct sequence numbers in the runs and the exclusions. */
const completedRuns = (runs: ComparisonRecordV1['runs'], exclusions: ComparisonRecordV1['exclusions']): number =>
  new Set([...runs.map((r) => r.seq), ...exclusions.map((x) => x.seq)]).size;

export const report: Handler = (args, io, deps) =>
  guarded(io, () => {
    const { values, positionals } = parse(args, { json: { type: 'boolean' }, redact: { type: 'boolean' } });
    if (positionals.length !== 1) throw new UsageError('expected one record: report <record.json|id> [--redact] [--json]');
    const arg = positionals[0]!;
    let record: ComparisonRecordV1;
    if (/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(arg)) {
      const r = readComparison(deps.fs, repoRootOf(deps), arg);
      if (!r.ok) throw new UsageError(`no comparison record "${arg}" (${r.errors.map((e) => e.message).join('; ')})`);
      record = r.record;
    } else {
      const text = deps.readFile(isAbsolute(arg) ? arg : resolve(deps.cwd, arg));
      if (text === undefined) throw new UsageError(`record file not found: ${arg}`);
      const r = parseRecord(text);
      if (!r.ok) throw new UsageError(`not a valid record: ${r.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
      if (r.record.kind !== 'comparison') throw new UsageError('this is a fixture, not a comparison record');
      record = r.record;
    }
    // Records written before have no labels: label them from their auth and the billing mode (asked once).
    // L6: a record stored before the model-change rule is shown (and exported) with the rule applied.
    let stored = record.labels;
    if (!stored) {
      const root = deps.findRepoRoot(deps.cwd);
      stored = costLabels(record.auth, root ? resolveBilling(deps, root, io.err) : null);
    }
    record = { ...record, labels: withModelChange(stored, record.versions.modelByArm) };
    if (values.redact) {
      // Share-safe export (R0-03, legal note §1 rule 3): a one-off salt, never stored or printed, re-derives every
      // hash, commit id, fixture name and non-config path, so the copy links to no store, repository or task name.
      const root = deps.findRepoRoot(deps.cwd);
      const identities = [...deps.machineIdentities(), ...(root ? deps.git.identities(root) : [])];
      try {
        record = redactRecord(record, { salt: deps.randomHex(), identities });
      } catch (e) {
        if (e instanceof RecordPrivacyError || e instanceof RecordSchemaError) {
          io.err(`${BIN_NAME}: no share-safe copy: ${e.message}`);
          return EXIT.internal;
        }
        throw e;
      }
      io.err('Share-safe copy: hashes, commit ids, fixture names and file names other than Claude Code config files are replaced; nothing was stored.');
    }
    if (values.json) io.out(serializeRecord(record).trimEnd());
    else for (const l of formatReport(record)) io.out(l);
    return EXIT.ok;
  });
