// `import-usage` (R0-09): turns native `/usage` recommendation rows and four checks Claude Code does not run
// (discovery §8.1: D2 idle-gap vs cache TTL fit, D3 cache-invalidating setup, D5 duplicate and contradictory text,
// D6 verbose-output hooks) into a ranked list of HYPOTHESES for `compare`. Nothing here is measured: every item is
// "estimated, not measured" or, when its expected effect is below the smallest effect `compare` can detect at its run
// cap, "estimated, not measurable" (legal note §2.2 rule 1). Pure: config files and session fields come in as values.
// Privacy (legal note §1): config text and transcript text never reach the output. The output holds repo-relative
// file:line evidence, counts, shares and the pasted row's own wording, scrubbed of absolute paths, secrets, e-mail
// addresses and identities (scrubText); assertNoLeaks re-checks the whole output before the CLI prints it.

import { COMPARE_DEFAULTS } from './compare';
import { ESTIMATED_NOT_MEASURABLE, ESTIMATED_NOT_MEASURED, MEASURING_QUALIFIER } from './labels';
import { CHARS_PER_TOKEN, DEFAULT_MODEL_WEIGHTS, modelWeights, tokensFromChars } from './model-weights';
import { findPrivacyLeaks, identityTokens, SECRET_PATTERNS, toRepoRelativePath } from './privacy';
import { DEFAULT_CV, minimumDetectableEffectT, planDegreesOfFreedom } from './stats';
import type { SessionFields, TranscriptStats } from './transcripts';
import type { ParsedUsage } from './usage-rows';

/** The two labels of an import-usage item (legal note §2.2 qualifier 1); the strings live in labels.ts. */
export const HYPOTHESIS_LABELS = { notMeasured: ESTIMATED_NOT_MEASURED, notMeasurable: ESTIMATED_NOT_MEASURABLE } as const;
export type HypothesisLabel = (typeof HYPOTHESIS_LABELS)[keyof typeof HYPOTHESIS_LABELS];

/** Task count the cutoff assumes: the default T1 fixture set (3 tasks), the shape the plan block is reviewed at. */
const REFERENCE_TASKS = 3;
/**
 * Smallest saving `compare` can detect at its run cap (60 runs = 30 per arm) with the assumed CV 0.30, α 0.05, power
 * 0.8, with Student t quantiles and df = 2·(n − K) like the plan block (QA review, stats-review-1031.md §10):
 * 19.45% for K = 3 (19.13% with normal quantiles; 19.8% at the most tasks the cap allows, K = 15).
 */
export const MDE_AT_RUN_CAP = minimumDetectableEffectT(DEFAULT_CV, COMPARE_DEFAULTS.maxRuns / 2, planDegreesOfFreedom(COMPARE_DEFAULTS.maxRuns / 2, REFERENCE_TASKS));

/**
 * Cost weights of tokens relative to uncached input. Source: platform.claude.com/docs/en/about-claude/pricing (accessed
 * 2026-11-26): 5m write 1.25x, 1h write 2x, output 5x on every listed model. `read` here is the DEFAULT for a request
 * whose model is unknown (0.1x, most models); a known model uses its own read weight (0.05x on Opus/Sonnet 5.5, 0.025x on
 * Fable/Mythos 5.1–5.2; model-weights.ts). Output is in the total because `compare` measures `total_cost_usd`
 * (QA review).
 */
export const TOKEN_WEIGHTS = { input: 1, write5m: 1.25, write1h: 2, read: DEFAULT_MODEL_WEIGHTS.read, output: 5 } as const;
const TTL_5M_MS = 5 * 60_000;
const TTL_1H_MS = 60 * 60_000;
/** A tool result above this many characters counts as large (about 5k tokens); D6 keeps about 100 lines (8,000 chars). */
export const LARGE_RESULT_CHARS = 20_000;
const KEPT_CHARS = 8_000;

export type CheckId = 'D2' | 'D3' | 'D5' | 'D6';
export type HypothesisSource = 'native' | CheckId;

export interface ConfigFile {
  /** Repo-relative POSIX path. */
  path: string;
  text: string;
}

export interface Evidence {
  /** What was found; never config or transcript text. */
  note: string;
  /** Repo-relative path and 1-based line, when the evidence is a file. */
  file?: string;
  line?: number;
}

export type Effect =
  /** Native row: the share of recent usage the row applies to – an upper bound, not the effect. */
  | { kind: 'applies-to'; share: number }
  /** A check's estimate of the change in total token cost (output tokens at 5x input in the total). */
  | { kind: 'estimate'; share: number }
  | { kind: 'unknown' };

export interface Hypothesis {
  id: string;
  rank: number;
  source: HypothesisSource;
  /** True when the hypothesis is a native `/usage` row (validation metric M7). */
  nativeRow: boolean;
  /** The change to try. */
  change: string;
  effect: Effect;
  label: HypothesisLabel;
  /** Why the label is "not measurable", or how to read the effect. */
  note: string;
  evidence: Evidence[];
  /** A `compare` command that tests the change once the user has written it as a patch. */
  compare: string;
  /** What the patch should do. */
  patch: string;
}

export interface CheckStatus {
  id: CheckId;
  name: string;
  status: 'ran' | 'skipped';
  /** Why skipped, or what ran on. */
  detail: string;
}

export interface HypothesisList {
  kind: 'crafthall-optimize/hypotheses';
  format: 1;
  /** First output line: verdict-style summary. */
  summary: string;
  hypotheses: Hypothesis[];
  checks: CheckStatus[];
  inputs: { usageRows: number; usageLinesIgnored: number; configFiles: number; transcripts: (TranscriptStats & { requests: number }) | null };
  mdeAtRunCap: number;
}

export interface ScrubContext {
  identities?: readonly string[];
  /** Absolute repo root, to turn pasted paths into repo-relative ones. */
  repoRoot?: string;
  /** Absolute home directory, to expand `~/` in pasted paths. */
  home?: string;
}

export interface HypothesisInput extends ScrubContext {
  usage: ParsedUsage | null;
  config: readonly ConfigFile[];
  /** Session fields when the user passed `--read-transcripts`; null otherwise. */
  transcripts: { sessions: readonly SessionFields[]; stats: TranscriptStats } | null;
  /** Binary name used in the suggested `compare` commands. */
  bin: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Scrubbing

const REDACTED = '[redacted]';
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATH_TOKEN = /(^|[\s"'=:(,;])((?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'·|,;)]*)/g;
const SLASH_COMMAND = /^\/[a-z][a-z0-9-]*$/;
/** File names that may stay visible after an outside-repo path is hidden (they name no person or project). */
const CONFIG_BASENAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'settings.json', 'settings.local.json', '.mcp.json', 'SKILL.md']);
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Removes absolute paths (repo paths become repo-relative), secrets, e-mail addresses and identities from a string. */
export function scrubText(text: string, ctx: ScrubContext = {}): string {
  let s = text.replace(PATH_TOKEN, (_m, pre: string, path: string) => {
    if (SLASH_COMMAND.test(path)) return pre + path;
    const expanded = /^~[\\/]/.test(path) && ctx.home ? ctx.home.replace(/[\\/]+$/, '') + path.slice(1) : path;
    const rel = ctx.repoRoot && !/^~/.test(expanded) ? toRepoRelativePath(expanded, ctx.repoRoot) : null;
    if (rel) return pre + rel;
    const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    return `${pre}<outside repo>${CONFIG_BASENAMES.has(base) ? `/${base}` : ''}`;
  });
  for (const re of SECRET_PATTERNS) s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), REDACTED);
  s = s.replace(EMAIL_G, REDACTED);
  // Longest first, so a full name goes before its single words (identityTokens adds the words).
  for (const t of identityTokens(ctx.identities).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(t)}(?=$|[^A-Za-z0-9])`, 'gi'), `$1${REDACTED}`);
  }
  return s;
}

/** Privacy leaks in a value about to be printed; single-segment slash commands (`/effort`, `/compact`) are allowed. */
export function outputLeaks(value: unknown, identities: readonly string[] = []) {
  const neutral = JSON.parse(JSON.stringify(value), (_k, v: unknown) =>
    typeof v === 'string' ? v.replace(/(^|[\s"'=:(,;])\/[a-z][a-z0-9-]*(?=$|[\s"'`),.;])/g, '$1cmd') : v,
  ) as unknown;
  return findPrivacyLeaks(neutral, { identities });
}

// ---------------------------------------------------------------------------------------------------------------
// Small parsers of config files (own parser per ADR-0001; no import of HQ code)

interface FrontmatterField {
  value: string;
  line: number;
}

/** `key: value` lines of a leading `---` block. */
export function frontmatter(text: string): Map<string, FrontmatterField> {
  const out = new Map<string, FrontmatterField>();
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '---') break;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(l);
    if (m) out.set(m[1]!, { value: m[2]!.trim().replace(/^["']|["']$/g, ''), line: i + 1 });
  }
  return out;
}

/** 1-based line of the first `"key"` in a JSON text; 1 when not found. */
const jsonKeyLine = (text: string, key: string): number => {
  const i = text.split(/\r?\n/).findIndex((l) => l.includes(`"${key}"`));
  return i < 0 ? 1 : i + 1;
};

const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const isMarkdown = (p: string): boolean => /\.md$/i.test(p);
/** Files Claude Code loads into every request: root CLAUDE.md files and rules without `paths:` frontmatter. */
const isAlwaysLoaded = (f: ConfigFile): boolean =>
  /^(?:CLAUDE\.md|CLAUDE\.local\.md|\.claude\/CLAUDE\.md)$/.test(f.path) || (/^\.claude\/rules\/.+\.md$/.test(f.path) && !frontmatter(f.text).has('paths'));
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

// ---------------------------------------------------------------------------------------------------------------
// Cost units of session fields

type Request = SessionFields['requests'][number];
/** Cache-read weight of the model that served the request (default 0.1x when unknown). */
const readWeight = (r: Request): number => modelWeights(r.model).read;

/** Token cost of one request in uncached-input units of its own model (output included; read at the model's weight). */
export const requestUnits = (r: Request): number =>
  r.input * TOKEN_WEIGHTS.input + r.write5m * TOKEN_WEIGHTS.write5m + r.write1h * TOKEN_WEIGHTS.write1h + r.read * readWeight(r) + r.output * TOKEN_WEIGHTS.output;

const units = requestUnits;
const totalUnits = (sessions: readonly SessionFields[]): number => sessions.reduce((a, s) => a + s.requests.reduce((b, r) => b + units(r), 0), 0);

// ---------------------------------------------------------------------------------------------------------------
// Checks

type Draft = Omit<Hypothesis, 'rank' | 'label' | 'compare'> & { forceNotMeasurable?: string };

/** D2: would the other cache TTL have cost less, given the user's own idle gaps? Needs session fields. */
export function checkD2(sessions: readonly SessionFields[]): Draft[] {
  let w5 = 0;
  let w1 = 0;
  let rewritesAfterMidGap = 0; // 5m TTL: writes that a 1h TTL would have served as reads
  let readsAfterMidGap = 0; // 1h TTL: reads that a 5m TTL would have had to write again
  // Same sums weighted by each request's own model: rewrite·(2 − read_m) and read·(1.25 − read_m).
  let rewriteGain = 0;
  let readLoss = 0;
  let gaps = 0;
  for (const s of sessions) {
    const main = s.requests.filter((r) => !r.sidechain && Number.isFinite(r.t));
    for (const r of main) {
      w5 += r.write5m;
      w1 += r.write1h;
    }
    for (let i = 1; i < main.length; i++) {
      const gap = main[i]!.t - main[i - 1]!.t;
      if (gap <= TTL_5M_MS || gap > TTL_1H_MS) continue;
      gaps++;
      const r = main[i]!;
      rewritesAfterMidGap += r.write5m;
      // Under 1h the cache is alive after a gap ≤ 60 min, so every read here would be a write under 5m, whether or not the
      // request also wrote its new turn at 1h (QA: a `write1h === 0` filter dropped nearly all of them).
      readsAfterMidGap += r.read;
      rewriteGain += r.write5m * (TOKEN_WEIGHTS.write1h - readWeight(r));
      readLoss += r.read * (TOKEN_WEIGHTS.write5m - readWeight(r));
    }
  }
  const total = totalUnits(sessions);
  if (total <= 0 || w5 + w1 <= 0) return [];
  const on1h = w1 > w5;
  // 5m → 1h: the mid-gap rewrites become reads (the request model's read weight) and every other write costs 2x, not 1.25x.
  // 1h → 5m: the mid-gap reads become writes (1.25x) and every write costs 1.25x instead of 2x.
  const delta = on1h ? w1 * (TOKEN_WEIGHTS.write1h - TOKEN_WEIGHTS.write5m) - readLoss : rewriteGain - w5 * (TOKEN_WEIGHTS.write1h - TOKEN_WEIGHTS.write5m);
  if (delta <= 0) return [];
  const target = on1h ? '5m' : '1h';
  return [
    {
      id: `D2-ttl-${target}`,
      source: 'D2',
      nativeRow: false,
      change: `Set the main-conversation prompt cache TTL to ${target} (promptCacheTtl)`,
      effect: { kind: 'estimate', share: delta / total },
      note: 'share of the token cost in the sessions read (output included); from your own idle gaps',
      evidence: [
        { note: `idle gaps between 5 and 60 minutes in the main conversation: ${gaps} (session files: ${sessions.length})` },
        { note: `cache writes: ${Math.round((w1 / (w1 + w5)) * 100)}% at the 1-hour TTL, ${Math.round((w5 / (w1 + w5)) * 100)}% at 5 minutes` },
      ],
      patch: `add "promptCacheTtl": "${target}" to .claude/settings.json`,
      forceNotMeasurable: 'compare runs are back-to-back headless runs with no idle gaps, so a TTL change does not show in them',
    },
  ];
}

/** D3: settings and skills that make Claude Code rebuild its prompt cache. Config only; the pasted cache line adds a cause. */
export function checkD3(config: readonly ConfigFile[], usage: ParsedUsage | null): Draft[] {
  const out: Draft[] = [];
  let sessionModel: string | null = null;
  for (const path of SETTINGS_FILES) {
    const f = config.find((c) => c.path === path);
    const json = f ? parseJson(f.text) : null;
    if (!f || !json) continue;
    if (typeof json['model'] === 'string') sessionModel = json['model'];
    if (json['model'] === 'opusplan')
      out.push({
        id: 'D3-opusplan',
        source: 'D3',
        nativeRow: false,
        change: 'Use one model instead of opusplan',
        effect: { kind: 'unknown' },
        note: 'opusplan switches model on every plan-mode toggle, and each switch reads the whole conversation with no cache hits',
        evidence: [{ note: 'model is opusplan', file: path, line: jsonKeyLine(f.text, 'model') }],
        patch: `set "model" in ${path} to the model you use for execution`,
      });
    const env = json['env'] && typeof json['env'] === 'object' ? (json['env'] as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(env)) {
      if (!/^DISABLE_PROMPT_CACHING(?:_HAIKU|_SONNET|_OPUS|_FABLE)?$/.test(k) || !/^(?:1|true|yes)$/i.test(String(v))) continue;
      out.push({
        id: `D3-${k.toLowerCase().replace(/_/g, '-')}`,
        source: 'D3',
        nativeRow: false,
        change: `Turn prompt caching back on (remove ${k})`,
        effect: { kind: 'unknown' },
        note: 'with caching off every request is billed as uncached input',
        evidence: [{ note: `${k} is set`, file: path, line: jsonKeyLine(f.text, k) }],
        patch: `remove ${k} from the env block of ${path}`,
      });
    }
  }
  const switching: Evidence[] = [];
  for (const f of config) {
    if (!/^\.claude\/(?:skills\/[^/]+\/SKILL\.md|commands\/.+\.md)$/.test(f.path)) continue;
    const fm = frontmatter(f.text);
    const model = fm.get('model');
    if (!model || !model.value || model.value === 'inherit' || fm.get('context')?.value === 'fork') continue;
    if (sessionModel && model.value === sessionModel) continue;
    const shown = MODEL_ID.test(model.value) ? model.value : 'another model';
    switching.push({ note: `sets model ${shown}`, file: f.path, line: model.line });
  }
  if (switching.length)
    out.push({
      id: 'D3-skill-model',
      source: 'D3',
      nativeRow: false,
      change: 'Remove the model setting from skills and commands that run in the main conversation, or run them with context: fork',
      effect: { kind: 'unknown' },
      note: 'a skill or command whose model differs from the session model is a model switch: the next request reads the whole conversation with no cache hits',
      evidence: switching,
      patch: 'delete the model: line (or add context: fork) in the files listed',
    });
  const cause = usage?.promptCache?.likelyCause;
  if (cause)
    out.push({
      id: 'D3-native-miss-cause',
      source: 'D3',
      nativeRow: false,
      change: `Remove what causes the cache misses /usage reports (likely cause: ${cause})`,
      effect: { kind: 'unknown' },
      note: `/usage names only the last miss; ${usage?.promptCache?.misses ?? 'some'} misses in the session`,
      evidence: [{ note: `pasted Prompt cache (main) line ${usage?.promptCache?.line}` }],
      patch: 'the setup change that stops the named cause (for example, connect MCP servers before the session starts)',
    });
  return out;
}

const normalize = (line: string): string =>
  line
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/^\s*(?:[#>*+-]+|\d+[.)])\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface Located {
  file: string;
  line: number;
  always: boolean;
  /** Characters of the trimmed line (tokens depend on the model's tokenizer, model-weights.ts). */
  chars: number;
}

/** Markdown lines outside code fences, with line numbers. */
function proseLines(text: string): { line: number; raw: string }[] {
  const out: { line: number; raw: string }[] = [];
  let fence = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    else if (!fence) out.push({ line: i + 1, raw });
  });
  return out;
}

const POSITIVE = new Set(['always', 'must']);
const POLARITY = /\b(always|never|must not|must|do not|dont|avoid)\s+((?:[a-z0-9]+\s+){3,}[a-z0-9]+)/;

/**
 * Duplicate lines (≥ 8 words, equal after normalising) across the Markdown config, outside code fences, and the
 * redundant copies in always-loaded files: characters and tokens at chars ÷ 4 per line, rounded up (the pre-
 * count). Shared by D5 and the `usage` report.
 */
export function duplicateLines(config: readonly ConfigFile[]): { dups: { file: string; line: number; always: boolean }[][]; redundantChars: number; redundantOldTokens: number } {
  const groups = new Map<string, Located[]>();
  for (const f of config.filter((c) => isMarkdown(c.path))) {
    const always = isAlwaysLoaded(f);
    for (const { line, raw } of proseLines(f.text)) {
      const n = normalize(raw);
      if (n.split(' ').length >= 8 && n.length >= 40) groups.set(n, [...(groups.get(n) ?? []), { file: f.path, line, always, chars: raw.trim().length }]);
    }
  }
  const dups = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || a[0]!.file.localeCompare(b[0]!.file) || a[0]!.line - b[0]!.line);
  let redundantChars = 0;
  let redundantOldTokens = 0;
  for (const g of dups) {
    const always = g.filter((l) => l.always);
    if (always.length > 1) {
      redundantChars += (always.length - 1) * always[0]!.chars;
      redundantOldTokens += (always.length - 1) * Math.ceil(always[0]!.chars / CHARS_PER_TOKEN);
    }
  }
  return { dups, redundantChars, redundantOldTokens };
}

/** Files Claude Code loads into every request (root CLAUDE.md files, rules without `paths:`), for the `usage` report. */
export const alwaysLoadedFiles = (config: readonly ConfigFile[]): ConfigFile[] => config.filter((f) => isMarkdown(f.path) && isAlwaysLoaded(f));

/** D5: exact and near-exact duplicate lines, and always/never contradictions, across CLAUDE.md, rules, skills, agents. */
export function checkD5(config: readonly ConfigFile[], sessions: readonly SessionFields[] | null): Draft[] {
  const files = config.filter((f) => isMarkdown(f.path));
  const polar = new Map<string, { positive: Located[]; negative: Located[] }>();
  for (const f of files) {
    const always = isAlwaysLoaded(f);
    for (const { line, raw } of proseLines(f.text)) {
      const n = normalize(raw);
      const loc: Located = { file: f.path, line, always, chars: raw.trim().length };
      const m = POLARITY.exec(n);
      if (m) {
        const key = m[2]!.split(' ').slice(0, 6).join(' ');
        const entry = polar.get(key) ?? { positive: [], negative: [] };
        (POSITIVE.has(m[1]!) ? entry.positive : entry.negative).push(loc);
        polar.set(key, entry);
      }
    }
  }
  const out: Draft[] = [];
  const { dups, redundantChars, redundantOldTokens } = duplicateLines(config);
  if (dups.length) {
    // Each main request reads the redundant text from cache: tokens on its own tokenizer at its own read weight.
    const main = sessions ? sessions.flatMap((s) => s.requests.filter((r) => !r.sidechain)) : [];
    const mainUnits = main.reduce((a, r) => a + units(r), 0);
    const redundantUnits = main.reduce((a, r) => a + redundantOldTokens * modelWeights(r.model).tokenizer * readWeight(r), 0);
    const modelled = main.length ? Math.round(main.reduce((a, r) => a + redundantOldTokens * modelWeights(r.model).tokenizer, 0) / main.length) : redundantOldTokens;
    const redundantAlways = redundantChars > 0 ? modelled : 0;
    const effect: Effect = redundantAlways > 0 && mainUnits > 0 ? { kind: 'estimate', share: redundantUnits / mainUnits } : { kind: 'unknown' };
    out.push({
      id: 'D5-duplicates',
      source: 'D5',
      nativeRow: false,
      change: 'Keep one copy of each duplicated instruction',
      effect,
      note:
        effect.kind === 'estimate'
          ? `about ${redundantAlways} redundant tokens in always-loaded files, read from cache on every request; share of the mean token cost per request`
          : redundantAlways > 0
            ? `about ${redundantAlways} redundant tokens in always-loaded files; pass --read-transcripts for a share`
            : 'duplicates are in files loaded on demand (skills, agents); their cost depends on how often they load',
      evidence: dups.slice(0, 5).map((g) => ({
        note: `same line in ${g.length} places: ${g
          .slice(0, 4)
          .map((l) => `${l.file}:${l.line}`)
          .join(', ')}${g.length > 4 ? ` (+${g.length - 4} more)` : ''}`,
        file: g[0]!.file,
        line: g[0]!.line,
      })),
      patch: `remove the extra copies (${dups.length} duplicated line${dups.length === 1 ? '' : 's'}); keep the one in the file that owns the rule`,
    });
  }
  const contradictions = [...polar.entries()].filter(([, e]) => e.positive.length && e.negative.length);
  if (contradictions.length)
    out.push({
      id: 'D5-contradictions',
      source: 'D5',
      nativeRow: false,
      change: 'Resolve instructions that say both "always" and "never" about the same thing',
      effect: { kind: 'unknown' },
      note: 'contradictions cost retries and rework rather than tokens per request; the effect shows only in compare',
      evidence: contradictions.slice(0, 5).map(([, e]) => ({
        note: `"always/must" at ${e.positive[0]!.file}:${e.positive[0]!.line} vs "never/do not" at ${e.negative[0]!.file}:${e.negative[0]!.line}`,
        file: e.positive[0]!.file,
        line: e.positive[0]!.line,
      })),
      patch: 'reword or delete one side of each pair',
    });
  return out;
}

/** True when a `PreToolUse` hook in the settings matches the Bash tool. */
export function hasBashPreToolUseHook(config: readonly ConfigFile[]): { found: boolean; file?: string; line?: number } {
  for (const path of SETTINGS_FILES) {
    const f = config.find((c) => c.path === path);
    const json = f ? parseJson(f.text) : null;
    const hooks = json?.['hooks'] && typeof json['hooks'] === 'object' ? (json['hooks'] as Record<string, unknown>)['PreToolUse'] : undefined;
    if (!f || !Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const matcher = h && typeof h === 'object' ? (h as Record<string, unknown>)['matcher'] : undefined;
      let matches = matcher === undefined || matcher === '' || matcher === '*';
      if (!matches && typeof matcher === 'string')
        try {
          matches = new RegExp(`^(?:${matcher})$`).test('Bash');
        } catch {
          matches = matcher.split('|').includes('Bash');
        }
      if (matches) return { found: true, file: path, line: jsonKeyLine(f.text, 'PreToolUse') };
    }
  }
  return { found: false };
}

const hasTestCommand = (config: readonly ConfigFile[]): string | null => {
  const pkg = config.find((c) => c.path === 'package.json');
  const scripts = pkg ? parseJson(pkg.text)?.['scripts'] : undefined;
  if (scripts && typeof scripts === 'object' && typeof (scripts as Record<string, unknown>)['test'] === 'string') return 'package.json';
  return config.find((c) => ['pytest.ini', 'pyproject.toml', 'go.mod', 'Cargo.toml'].includes(c.path))?.path ?? null;
};

/** D6: large Bash results with no `PreToolUse` filter. Sizes need session fields; config alone gives an unsized hypothesis. */
export function checkD6(config: readonly ConfigFile[], sessions: readonly SessionFields[] | null): Draft[] {
  const hook = hasBashPreToolUseHook(config);
  if (hook.found) return [];
  const base = {
    id: 'D6-bash-output-filter',
    source: 'D6' as const,
    nativeRow: false,
    change: 'Add a PreToolUse hook on Bash that keeps the last 100 lines of test and build output',
    patch: 'add a PreToolUse hook with matcher "Bash" to .claude/settings.json (the costs page has a ready example)',
  };
  if (!sessions) {
    const test = hasTestCommand(config);
    if (!test) return [];
    return [
      {
        ...base,
        effect: { kind: 'unknown' },
        note: 'no PreToolUse filter on Bash and the repo has a test command; pass --read-transcripts to size the output',
        evidence: [{ note: 'test command found', file: test, line: test === 'package.json' ? jsonKeyLine(config.find((c) => c.path === test)!.text, 'test') : 1 }],
      },
    ];
  }
  let large = 0;
  let excessUnits = 0;
  for (const s of sessions) {
    // The session's cache TTL decides the write weight of the excess (majority of writes, as in D2; a tie counts as 5m).
    const w1 = s.requests.reduce((a, r) => a + r.write1h, 0);
    const w5 = s.requests.reduce((a, r) => a + r.write5m, 0);
    const writeWeight = w1 > w5 ? TOKEN_WEIGHTS.write1h : TOKEN_WEIGHTS.write5m;
    for (const r of s.toolResults) {
      if (!r.bash || r.chars <= LARGE_RESULT_CHARS) continue;
      large++;
      // Later requests on the result's own chain (parent links); without links, later requests with the same
      // sidechain flag. Compaction is ignored: a result summarised away still counts as re-read (an overstatement).
      const later: Request[] = r.later
        ? r.later.map((i) => s.requests[i]!).filter(Boolean)
        : Number.isFinite(r.t)
          ? s.requests.filter((q) => q.t > r.t && (r.sidechain === undefined || q.sidechain === r.sidechain))
          : [];
      // The first later request writes the excess (tokens on its model's tokenizer); every other one reads it at its
      // own model's read weight. A result with no later request still pays one write (unknown model weights).
      const [writer, ...readers] = later;
      const excess = tokensFromChars(r.chars - KEPT_CHARS, writer?.model);
      excessUnits += excess * writeWeight + readers.reduce((a, q) => a + excess * readWeight(q), 0);
    }
  }
  const total = totalUnits(sessions);
  if (!large || total <= 0) return [];
  return [
    {
      ...base,
      effect: { kind: 'estimate', share: Math.min(1, excessUnits / total) },
      note: `share of the token cost in the sessions read (output included): the part of large Bash results beyond about 100 lines, written once and re-read by later requests on the same chain`,
      evidence: [{ note: `${large} Bash results over ${LARGE_RESULT_CHARS} characters, no PreToolUse filter on Bash` }],
    },
  ];
}

/** Native `/usage` recommendation rows as hypotheses: the share is what the row applies to, not its effect. */
export function nativeDrafts(usage: ParsedUsage | null, ctx: ScrubContext): Draft[] {
  return (usage?.rows ?? []).map((row, i) => {
    const change = scrubText(row.action, ctx).slice(0, 120);
    const detail = row.detail ? scrubText(row.detail, ctx).slice(0, 80) : null;
    return {
      id: `native-${i + 1}`,
      source: 'native' as const,
      nativeRow: true,
      change: detail ? `${change} · ${detail}` : change,
      effect: { kind: 'applies-to' as const, share: row.share },
      note: 'the share of recent usage this row applies to, not what the change would change (Claude Code costs page)',
      evidence: [{ note: `pasted /usage row, line ${row.line}` }],
      patch: row.shape === 'effort' ? `set the effort level the row names (${detail ?? '/effort'}) in your settings` : row.shape === 'run' ? 'a habit, not a setup change: run the command the row names' : 'make the change this row describes',
      ...(row.shape === 'run' ? { forceNotMeasurable: 'the row asks for a habit at the prompt, which a fixture run cannot reproduce' } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Ranking and the list

const SOURCE_ORDER: Record<HypothesisSource, number> = { native: 0, D3: 1, D6: 2, D2: 3, D5: 4 };
const effectValue = (e: Effect): number => (e.kind === 'unknown' ? -1 : e.share);
const pct = (x: number): string => `${x < 0.001 ? '<0.1' : (x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/** Labels a draft: "not measurable" when forced or when its effect (or the row's share, an upper bound) is below the MDE. */
function labelOf(d: Draft): { label: HypothesisLabel; note: string } {
  if (d.forceNotMeasurable) return { label: HYPOTHESIS_LABELS.notMeasurable, note: `${d.note}; not measurable: ${d.forceNotMeasurable}` };
  if (d.effect.kind !== 'unknown' && d.effect.share < MDE_AT_RUN_CAP)
    return {
      label: HYPOTHESIS_LABELS.notMeasurable,
      note: `${d.note}; not measurable: below ${pct(MDE_AT_RUN_CAP)}, the smallest effect compare can detect at its ${COMPARE_DEFAULTS.maxRuns}-run cap (CV ${DEFAULT_CV} assumed)`,
    };
  return { label: HYPOTHESIS_LABELS.notMeasured, note: d.note };
}

/** Builds the ranked hypothesis list. Pure and deterministic. */
export function buildHypotheses(input: HypothesisInput): HypothesisList {
  const ctx: ScrubContext = { identities: input.identities ?? [], repoRoot: input.repoRoot, home: input.home };
  const sessions = input.transcripts?.sessions ?? null;
  const drafts = [
    ...nativeDrafts(input.usage, ctx),
    ...(sessions ? checkD2(sessions) : []),
    ...checkD3(input.config, input.usage),
    ...checkD5(input.config, sessions),
    ...checkD6(input.config, sessions),
  ];
  drafts.sort((a, b) => effectValue(b.effect) - effectValue(a.effect) || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.id.localeCompare(b.id));
  const hypotheses: Hypothesis[] = drafts.map((d, i) => {
    const rest: Omit<Draft, 'forceNotMeasurable'> = { ...d };
    delete (rest as Draft).forceNotMeasurable;
    const { label, note } = labelOf(d);
    return {
      ...rest,
      change: scrubText(rest.change, ctx),
      evidence: rest.evidence.map((e) => ({ ...e, note: scrubText(e.note, ctx), ...(e.file ? { file: scrubText(e.file, ctx) } : {}) })),
      rank: i + 1,
      label,
      note: scrubText(note, ctx),
      patch: scrubText(rest.patch, ctx),
      compare: `${input.bin} compare --change optimize-${d.id}.patch --plan-only`,
    };
  });
  const checks: CheckStatus[] = [
    sessions
      ? { id: 'D2', name: 'idle-gap vs cache TTL fit', status: 'ran', detail: `${input.transcripts!.stats.sessions} session files` }
      : { id: 'D2', name: 'idle-gap vs cache TTL fit', status: 'skipped', detail: 'needs your session timestamps: pass --read-transcripts <dir>' },
    { id: 'D3', name: 'cache-invalidating setup', status: 'ran', detail: `settings, skills and commands${input.usage?.promptCache ? ' plus the pasted Prompt cache line' : ''}` },
    { id: 'D5', name: 'duplicate and contradictory text', status: 'ran', detail: `${input.config.filter((f) => isMarkdown(f.path)).length} Markdown config files` },
    { id: 'D6', name: 'verbose-output hooks', status: 'ran', detail: sessions ? 'settings plus tool-result sizes' : 'settings only (sizes need --read-transcripts)' },
  ];
  const native = hypotheses.filter((h) => h.nativeRow).length;
  const fromChecks = hypotheses.length - native;
  const notMeasurable = hypotheses.filter((h) => h.label === HYPOTHESIS_LABELS.notMeasurable).length;
  const summary = hypotheses.length
    ? `${hypotheses.length} hypothes${hypotheses.length === 1 ? 'is' : 'es'} to test with compare (${HYPOTHESIS_LABELS.notMeasured}): ${native} from native /usage rows, ${fromChecks} from non-native checks; ${notMeasurable} ${HYPOTHESIS_LABELS.notMeasurable}`
    : `No hypotheses (${HYPOTHESIS_LABELS.notMeasured}): no /usage rows pasted and the non-native checks found nothing`;
  const requests = sessions ? sessions.reduce((a, s) => a + s.requests.length, 0) : 0;
  return {
    kind: 'crafthall-optimize/hypotheses',
    format: 1,
    summary,
    hypotheses,
    checks,
    inputs: {
      usageRows: input.usage?.rows.length ?? 0,
      usageLinesIgnored: input.usage?.ignored ?? 0,
      configFiles: input.config.length,
      transcripts: input.transcripts ? { ...input.transcripts.stats, requests } : null,
    },
    mdeAtRunCap: MDE_AT_RUN_CAP,
  };
}

/**
 * The list as the claim check sees it: pasted `/usage` wording (a native row's change and patch) is the user's input,
 * not our claim, so it is replaced by a placeholder; everything Optimize writes itself stays as it is.
 */
export function ownWording(list: HypothesisList): HypothesisList {
  return { ...list, hypotheses: list.hypotheses.map((h) => (h.nativeRow ? { ...h, change: 'native /usage row', patch: 'the change the row describes' } : h)) };
}

const effectText = (e: Effect): string =>
  e.kind === 'applies-to' ? `applies to ${pct(e.share)} of recent usage (upper bound, not the effect)` : e.kind === 'estimate' ? `about ${pct(e.share)} of token cost` : 'effect size unknown';

/** Human text: the summary first, then one block per hypothesis, then the checks. Never says "saved". */
export function formatHypotheses(list: HypothesisList): string[] {
  const lines = [list.summary, ''];
  for (const h of list.hypotheses) {
    lines.push(`${h.rank}. [${h.nativeRow ? 'native /usage row' : `${h.source}, not native`}] ${h.change}`);
    lines.push(`   ${effectText(h.effect)} – ${h.label}`);
    lines.push(`   ${h.note}`);
    for (const e of h.evidence) {
      const at = e.file ? `${e.file}:${e.line ?? 1}` : null;
      lines.push(`   evidence: ${e.note}${at && !e.note.includes(at) ? ` (${at})` : ''}`);
    }
    lines.push(`   patch: ${h.patch}`);
    lines.push(`   try: ${h.compare}`);
    lines.push('');
  }
  lines.push('Checks:');
  for (const c of list.checks) lines.push(`  ${c.id} ${c.name}: ${c.status} – ${c.detail}`);
  const t = list.inputs.transcripts;
  lines.push(
    '',
    `Read: ${list.inputs.configFiles} config files in this repository; ${list.inputs.usageRows} pasted /usage rows${list.inputs.usageLinesIgnored ? ` (${list.inputs.usageLinesIgnored} other lines ignored)` : ''}; ` +
      (t ? `${t.sessions} session files (usage fields only, ${t.requests} requests; ${t.unknownRecords} records of other types skipped).` : 'session records: not read (opt in with --read-transcripts <dir>).'),
    'These are hypotheses, not results: write the change as a patch and measure it with compare. Nothing was stored.',
    MEASURING_QUALIFIER,
  );
  return lines;
}
