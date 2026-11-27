// `usage` (R1-20): how many tokens this repository's Claude Code sessions used, where they went, and the ranked
// fixes of `import-usage` with the share of tokens behind each. Totals are sums of the usage fields of the session
// records (deduplicated by `requestId` in transcripts.ts); the share behind each non-native check D1–D6 is an estimate
// ("estimated, not measured"); the fixes reuse buildHypotheses unchanged. Pure: session fields and config come in as
// values; nothing is stored.
// Token counts here are plain token counts (input + cache writes + cache reads + output), not cost units: the report
// answers "how many tokens", the ranking of the fixes keeps the cost-weighted share of import-usage.
// Privacy (legal note §1): the report holds counts, model ids, UTC days, session ids that are UUIDs (any other file
// name becomes `session-N`), repo-relative `file:line` evidence and fixed wording. No message, tool or config text.

import { ESTIMATED_NOT_MEASURED, MEASURING_QUALIFIER } from './labels';
import { parseModelId, tokensFromChars, CHARS_PER_TOKEN, modelWeights } from './model-weights';
import {
  alwaysLoadedFiles,
  buildHypotheses,
  duplicateLines,
  frontmatter,
  hasBashPreToolUseHook,
  LARGE_RESULT_CHARS,
  type ConfigFile,
  type Evidence,
  type Effect,
  type HypothesisInput,
  type HypothesisLabel,
  type HypothesisList,
  type HypothesisSource,
} from './hypotheses';
import type { RequestFields, SessionFields, ToolResultFields, TranscriptStats } from './transcripts';

export const TOKEN_USAGE_KIND = 'crafthall-optimize/token-usage';
export const TOKEN_USAGE_FORMAT = 1;
export const DEFAULT_USAGE_DAYS = 7;
export const MAX_USAGE_DAYS = 3650;
const DAY_MS = 86_400_000;
const TTL_5M_MS = 5 * 60_000;
const TTL_1H_MS = 60 * 60_000;
const TOP_SESSIONS = 5;
const MAX_EVIDENCE = 5;

/** Token counts by component. `total` is the sum of the other five. */
export interface TokenComponents {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  total: number;
}

export type UsageCheckId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

export interface CheckShare {
  id: UsageCheckId;
  name: string;
  /** Estimated tokens of the period that this check is about (never above the total). */
  tokens: number;
  /** tokens ÷ total tokens, 0..1. */
  share: number;
  label: typeof ESTIMATED_NOT_MEASURED;
  /** How the tokens were counted. */
  basis: string;
  evidence: Evidence[];
}

export interface Improvement {
  rank: number;
  id: string;
  source: HypothesisSource;
  nativeRow: boolean;
  change: string;
  /** The import-usage estimate (share of token cost, or the share a native row applies to); unchanged. */
  effect: Effect;
  label: HypothesisLabel;
  /** Share of the period's tokens behind the check this fix comes from (an upper bound of what it touches); null for native rows. */
  tokenShare: number | null;
  note: string;
  evidence: Evidence[];
  patch: string;
  compare: string;
}

export interface TokenUsageReport {
  kind: typeof TOKEN_USAGE_KIND;
  format: typeof TOKEN_USAGE_FORMAT;
  summary: string;
  label: typeof ESTIMATED_NOT_MEASURED;
  window: { days: number; from: string; to: string };
  totals: TokenComponents;
  byModel: (TokenComponents & { model: string; requests: number })[];
  byDay: (TokenComponents & { day: string; requests: number })[];
  byRole: { main: TokenComponents & { requests: number }; subagents: TokenComponents & { requests: number } };
  topSessions: { id: string; requests: number; tokens: number; share: number; subagentTokens: number }[];
  checks: CheckShare[];
  improvements: Improvement[];
  inputs: {
    source: 'project-folder' | 'read-transcripts';
    sessionFiles: number;
    subagentFiles: number;
    requests: number;
    requestsOutsideWindow: number;
    undatedRequests: number;
    unknownRecords: number;
    malformedLines: number;
    configFiles: number;
    usageRows: number;
  };
}

/** One session file: its id (the session id; a subagent file carries its parent's id) and its usage fields. */
export interface UsageSession {
  id: string;
  subagent: boolean;
  fields: SessionFields;
}

export interface TokenUsageInput extends Omit<HypothesisInput, 'transcripts'> {
  sessions: readonly UsageSession[];
  stats: TranscriptStats;
  now: Date;
  days: number;
  source: 'project-folder' | 'read-transcripts';
}

// ---------------------------------------------------------------------------------------------------------------
// Window and sums

/**
 * Requests and tool results of a session at or after `fromMs` (records with no readable timestamp are dropped), with
 * the `later` chain indexes remapped to the kept requests. Pure.
 */
export function windowSession(fields: SessionFields, fromMs: number): SessionFields {
  const index = new Map<number, number>();
  const requests: RequestFields[] = [];
  fields.requests.forEach((r, i) => {
    if (Number.isFinite(r.t) && r.t >= fromMs) {
      index.set(i, requests.length);
      requests.push(r);
    }
  });
  const toolResults: ToolResultFields[] = fields.toolResults
    .filter((r) => Number.isFinite(r.t) && r.t >= fromMs)
    .map((r) => (r.later ? { ...r, later: r.later.flatMap((i) => (index.has(i) ? [index.get(i)!] : [])) } : r));
  return { requests, toolResults, ttlSplit: fields.ttlSplit };
}

export const emptyComponents = (): TokenComponents => ({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, total: 0 });

/** Plain token count of one request: input + cache writes (5m, 1h) + cache read + output. */
export const requestTokens = (r: RequestFields): number => r.input + r.write5m + r.write1h + r.read + r.output;

function addRequest(c: TokenComponents, r: RequestFields): void {
  c.input += r.input;
  c.cacheWrite5m += r.write5m;
  c.cacheWrite1h += r.write1h;
  c.cacheRead += r.read;
  c.output += r.output;
  c.total += requestTokens(r);
}

const isSubagent = (s: UsageSession, r: RequestFields): boolean => s.subagent || r.sidechain;
const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session id that may be printed: a UUID (what Claude Code names its files) or null. */
export const printableSessionId = (name: string): string | null => (UUID.test(name) ? name.toLowerCase() : null);

// ---------------------------------------------------------------------------------------------------------------
// Shares behind the checks D1–D6 (estimates)

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const lineOf = (text: string, needle: string): number => {
  const i = text.split(/\r?\n/).findIndex((l) => l.includes(needle));
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
const inputSide = (r: RequestFields): number => r.input + r.write5m + r.write1h + r.read;

interface Flat {
  s: UsageSession;
  r: RequestFields;
}

function checkShares(sessions: readonly UsageSession[], config: readonly ConfigFile[], hyp: HypothesisList, total: number): CheckShare[] {
  const all: Flat[] = sessions.flatMap((s) => s.fields.requests.map((r) => ({ s, r })));
  const main = all.filter((x) => !isSubagent(x.s, x.r));
  const cap = (n: number): number => Math.round(Math.max(0, Math.min(total, n)));
  const make = (id: UsageCheckId, name: string, tokens: number, basis: string, evidence: Evidence[]): CheckShare => {
    const t = cap(tokens);
    return { id, name, tokens: t, share: total > 0 ? t / total : 0, label: ESTIMATED_NOT_MEASURED, basis, evidence: evidence.slice(0, MAX_EVIDENCE) };
  };
  const hypEvidence = (source: HypothesisSource): Evidence[] => hyp.hypotheses.filter((h) => h.source === source).flatMap((h) => h.evidence.filter((e) => e.file));

  // D1 model pinning: subagent requests served by an Opus model (subagents inherit the session model unless pinned).
  const d1 = all.filter((x) => isSubagent(x.s, x.r) && parseModelId(x.r.model)?.family === 'opus').reduce((a, x) => a + requestTokens(x.r), 0);
  const d1Evidence: Evidence[] = [];
  for (const path of SETTINGS_FILES) {
    const f = config.find((c) => c.path === path);
    const model = f ? parseJson(f.text)?.['model'] : undefined;
    if (f && typeof model === 'string') d1Evidence.push({ note: 'session model set in the settings', file: path, line: lineOf(f.text, '"model"') });
  }
  for (const f of config.filter((c) => /^\.claude\/agents\/[^/]+\.md$/.test(c.path))) {
    const m = frontmatter(f.text).get('model');
    if (!m || m.value === 'inherit') d1Evidence.push({ note: 'agent without its own model: runs on the session model', file: f.path, line: m?.line ?? 1 });
    else if (/opus/i.test(m.value)) d1Evidence.push({ note: 'agent pinned to an Opus model', file: f.path, line: m.line });
  }
  const d1Share = make('D1', 'model and effort pinning', d1, 'tokens of subagent requests served by an Opus model', d1Evidence);

  // D2 idle gaps vs cache TTL, per session as checkD2 (majority of the session's main cache writes decides its TTL):
  // on the 5m TTL the cache writes right after a 5–60 minute gap (what a 1h TTL would serve as reads); on the 1h TTL
  // the cache reads right after such a gap (what a 5m TTL would have to write again) – a gap inside the 1h TTL causes no write.
  // D3 cache misses: main requests that read nothing from cache although the previous request's cache was still alive.
  let d2 = 0;
  let d3 = 0;
  let gaps = 0;
  let misses = 0;
  let gaps1h = 0;
  for (const s of sessions) {
    if (s.subagent) continue;
    const seq = s.fields.requests.filter((r) => !r.sidechain);
    const on1h = seq.reduce((a, r) => a + r.write1h, 0) > seq.reduce((a, r) => a + r.write5m, 0);
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1]!;
      const r = seq[i]!;
      const gap = r.t - prev.t;
      if (gap > TTL_5M_MS && gap <= TTL_1H_MS) {
        gaps++;
        if (on1h) {
          gaps1h++;
          d2 += r.read;
        } else d2 += r.write5m + r.write1h;
      }
      const ttl = prev.write1h > prev.write5m ? TTL_1H_MS : TTL_5M_MS;
      if (r.read === 0 && r.write5m + r.write1h > 0 && gap <= ttl) {
        misses++;
        d3 += r.input + r.write5m + r.write1h;
      }
    }
  }
  const ttlEvidence: Evidence[] = [];
  for (const path of SETTINGS_FILES) {
    const f = config.find((c) => c.path === path);
    if (f && f.text.includes('"promptCacheTtl"')) ttlEvidence.push({ note: 'promptCacheTtl set', file: path, line: lineOf(f.text, '"promptCacheTtl"') });
  }
  const d2Share = make('D2', 'idle-gap vs cache TTL fit', d2, `after ${gaps} idle gap${gaps === 1 ? '' : 's'} of 5–60 minutes in the main conversation: the cache writes on 5m-TTL sessions (${gaps - gaps1h} gap${gaps - gaps1h === 1 ? '' : 's'}) and the cache reads on 1h-TTL sessions (${gaps1h}), as in the D2 fix`, [
    ...ttlEvidence,
    ...hypEvidence('D2'),
  ]);
  const d3Share = make('D3', 'cache-invalidating setup', d3, `uncached input and cache writes of ${misses} main request${misses === 1 ? '' : 's'} that read nothing from a cache still alive (cache misses)`, hypEvidence('D3'));

  // D4 fixed context: always-loaded files and the skill and agent descriptions, carried by every main request.
  const always = alwaysLoadedFiles(config);
  const described = config.filter((c) => /^\.claude\/(?:skills\/[^/]+\/SKILL\.md|agents\/[^/]+\.md)$/.test(c.path)).map((c) => ({ c, d: frontmatter(c.text).get('description') }));
  const descriptions = described.filter((x) => x.d && x.d.value);
  const fixedChars = always.reduce((a, f) => a + f.text.length, 0) + descriptions.reduce((a, x) => a + x.d!.value.length, 0);
  const fixedOld = Math.ceil(fixedChars / CHARS_PER_TOKEN);
  const d4 = main.reduce((a, x) => a + Math.min(inputSide(x.r), fixedOld * modelWeights(x.r.model).tokenizer), 0);
  const d4Evidence: Evidence[] = always.map((f) => ({ note: `loaded into every request: ${f.text.split(/\r?\n/).length} lines, ${group(f.text.length)} characters`, file: f.path, line: 1 }));
  if (descriptions.length) d4Evidence.push({ note: `${descriptions.length} skill and agent descriptions loaded into every request`, file: descriptions[0]!.c.path, line: descriptions[0]!.d!.line });
  const mcp = config.find((c) => c.path === '.mcp.json');
  const servers = mcp ? parseJson(mcp.text)?.['mcpServers'] : undefined;
  if (mcp && servers && typeof servers === 'object')
    d4Evidence.unshift({ note: `${Object.keys(servers).length} MCP servers: their tool lists are not in the records and are not counted`, file: '.mcp.json', line: lineOf(mcp.text, '"mcpServers"') });
  const d4Share = make('D4', 'fixed context size', d4, `about ${group(fixedOld)} tokens of always-loaded files and descriptions (characters ÷ ${CHARS_PER_TOKEN} × the model's tokenizer factor) carried by each of ${group(main.length)} main requests`, d4Evidence);

  // D5 duplicate text: the redundant copies in always-loaded files, carried by every main request.
  const dup = duplicateLines(config);
  const d5 = main.reduce((a, x) => a + Math.min(inputSide(x.r), dup.redundantOldTokens * modelWeights(x.r.model).tokenizer), 0);
  const d5Share = make('D5', 'duplicate and contradictory text', d5, `about ${group(dup.redundantOldTokens)} redundant tokens in always-loaded files carried by each of ${group(main.length)} main requests`, hypEvidence('D5'));

  // D6 repeated Bash output: large Bash results, carried by every later request on their own chain (at least once).
  let d6 = 0;
  let large = 0;
  for (const s of sessions) {
    const reqs = s.fields.requests;
    for (const r of s.fields.toolResults) {
      if (!r.bash || r.chars <= LARGE_RESULT_CHARS) continue;
      large++;
      const later = r.later ? r.later.map((i) => reqs[i]!).filter(Boolean) : reqs.filter((q) => q.t > r.t && (r.sidechain === undefined || q.sidechain === r.sidechain));
      // Tokenizer of the request that carries it first; with none after it, of the request that made the call (the last before it).
      const ref = later[0] ?? [...reqs].reverse().find((q) => q.t <= r.t);
      // Each carrying request is capped at its own input side (as D4/D5), so ignoring compaction cannot overstate it.
      const size = tokensFromChars(r.chars, ref?.model);
      const carriers = later.length ? later : ref ? [ref] : [];
      d6 += carriers.length ? carriers.reduce((a, q) => a + Math.min(inputSide(q), size), 0) : size;
    }
  }
  const hook = hasBashPreToolUseHook(config);
  const settings = config.find((c) => c.path === '.claude/settings.json');
  const d6Evidence: Evidence[] = hook.found
    ? [{ note: 'a PreToolUse hook on Bash is set', file: hook.file, line: hook.line }]
    : settings
      ? [{ note: 'no PreToolUse hook on Bash in the settings', file: settings.path, line: 1 }]
      : [{ note: 'no .claude/settings.json, so no PreToolUse hook on Bash' }];
  const d6Share = make('D6', 'repeated Bash output', d6, `${large} Bash result${large === 1 ? '' : 's'} over ${group(LARGE_RESULT_CHARS)} characters (characters ÷ ${CHARS_PER_TOKEN} × tokenizer factor), counted once per later request on the same chain and at least once (re-sent context, mostly cache reads, counted in full as in the totals, at most each request's input side)`, d6Evidence);

  return [d1Share, d2Share, d3Share, d4Share, d5Share, d6Share];
}

// ---------------------------------------------------------------------------------------------------------------
// The report

const group = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const formatPercent = (x: number): string => (x > 0 && x < 0.001 ? '<0.1%' : `${(x * 100).toFixed(1)}%`);

/** Builds the token usage report. Pure and deterministic for the same input. */
export function buildTokenUsage(input: TokenUsageInput): TokenUsageReport {
  const days = input.days;
  const toMs = input.now.getTime();
  const fromMs = toMs - days * DAY_MS;
  let undated = 0;
  let outside = 0;
  const sessions: UsageSession[] = input.sessions.map((s) => {
    for (const r of s.fields.requests) {
      if (!Number.isFinite(r.t)) undated++;
      else if (r.t < fromMs) outside++;
    }
    return { ...s, fields: windowSession(s.fields, fromMs) };
  });

  const totals = emptyComponents();
  const models = new Map<string, TokenComponents & { requests: number }>();
  const dayMap = new Map<string, TokenComponents & { requests: number }>();
  const main = { ...emptyComponents(), requests: 0 };
  const subagents = { ...emptyComponents(), requests: 0 };
  const bySession = new Map<string, { requests: number; tokens: number; subagentTokens: number }>();
  let requests = 0;
  for (const s of sessions)
    for (const r of s.fields.requests) {
      requests++;
      addRequest(totals, r);
      const m = r.model ?? 'unknown model';
      const mc = models.get(m) ?? { ...emptyComponents(), requests: 0 };
      addRequest(mc, r);
      mc.requests++;
      models.set(m, mc);
      const d = utcDay(r.t);
      const dc = dayMap.get(d) ?? { ...emptyComponents(), requests: 0 };
      addRequest(dc, r);
      dc.requests++;
      dayMap.set(d, dc);
      const role = isSubagent(s, r) ? subagents : main;
      addRequest(role, r);
      role.requests++;
      const sc = bySession.get(s.id) ?? { requests: 0, tokens: 0, subagentTokens: 0 };
      sc.requests++;
      sc.tokens += requestTokens(r);
      if (isSubagent(s, r)) sc.subagentTokens += requestTokens(r);
      bySession.set(s.id, sc);
    }
  const total = totals.total;

  const hyp = buildHypotheses({ ...input, transcripts: { sessions: sessions.map((s) => s.fields), stats: input.stats } });
  const checks = checkShares(sessions, input.config, hyp, total);
  const shareOf = new Map(checks.map((c) => [c.id as string, c.share]));
  const improvements: Improvement[] = hyp.hypotheses.map((h) => ({
    rank: h.rank,
    id: h.id,
    source: h.source,
    nativeRow: h.nativeRow,
    change: h.change,
    effect: h.effect,
    label: h.label,
    tokenShare: h.nativeRow ? null : (shareOf.get(h.source) ?? null),
    note: h.note,
    evidence: h.evidence,
    patch: h.patch,
    compare: h.compare,
  }));

  const topSessions = [...bySession.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))
    .slice(0, TOP_SESSIONS)
    .map(([id, v]) => ({ id, requests: v.requests, tokens: v.tokens, share: total > 0 ? v.tokens / total : 0, subagentTokens: v.subagentTokens }));
  const sessionCount = bySession.size;
  const summary = requests
    ? `${group(total)} tokens in the last ${days} day${days === 1 ? '' : 's'}: ${sessionCount} session${sessionCount === 1 ? '' : 's'}, ${group(requests)} request${requests === 1 ? '' : 's'} (counted from your session records; the shares behind the checks and the fixes are ${ESTIMATED_NOT_MEASURED})`
    : `No requests in the last ${days} day${days === 1 ? '' : 's'} in the session records read (${outside} older, ${undated} undated); try a larger --days`;

  return {
    kind: TOKEN_USAGE_KIND,
    format: TOKEN_USAGE_FORMAT,
    summary,
    label: ESTIMATED_NOT_MEASURED,
    window: { days, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    totals,
    byModel: [...models.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])).map(([model, c]) => ({ model, ...c })),
    byDay: [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, c]) => ({ day, ...c })),
    byRole: { main, subagents },
    topSessions,
    checks,
    improvements,
    inputs: {
      source: input.source,
      sessionFiles: input.sessions.filter((s) => !s.subagent).length,
      subagentFiles: input.sessions.filter((s) => s.subagent).length,
      requests,
      requestsOutsideWindow: outside,
      undatedRequests: undated,
      unknownRecords: input.stats.unknownRecords,
      malformedLines: input.stats.malformedLines,
      configFiles: input.config.length,
      usageRows: input.usage?.rows.length ?? 0,
    },
  };
}

const COMPONENT_ROWS: readonly [keyof TokenComponents, string][] = [
  ['input', 'input (uncached)'],
  ['cacheWrite5m', 'cache write, 5m TTL'],
  ['cacheWrite1h', 'cache write, 1h TTL'],
  ['cacheRead', 'cache read'],
  ['output', 'output'],
];

const effectText = (e: Effect): string =>
  e.kind === 'applies-to' ? `applies to ${formatPercent(e.share)} of recent usage (upper bound, not the effect)` : e.kind === 'estimate' ? `about ${formatPercent(e.share)} of token cost` : 'effect size unknown';

/** Human text: the summary first, then the sums, the shares behind the checks, the fixes and what was read. */
export function formatTokenUsage(rep: TokenUsageReport): string[] {
  const total = rep.totals.total;
  const pctOf = (n: number): string => formatPercent(total > 0 ? n / total : 0);
  const lines = [rep.summary, ''];
  const table = (rows: [string, number, string?][]): string[] => {
    const w = Math.max(...rows.map((r) => r[0].length));
    const nw = Math.max(...rows.map((r) => group(r[1]).length));
    return rows.map(([name, n, extra]) => `  ${name.padEnd(w)}  ${group(n).padStart(nw)}  ${pctOf(n).padStart(6)}${extra ? `  ${extra}` : ''}`);
  };
  lines.push('Tokens by component:', ...table([...COMPONENT_ROWS.map(([k, name]): [string, number] => [name, rep.totals[k]]), ['total', total]]), '');
  if (rep.byModel.length) lines.push('By model:', ...table(rep.byModel.map((m) => [m.model, m.total, `${group(m.requests)} requests`])), '');
  if (rep.byDay.length) lines.push('By day (UTC):', ...table(rep.byDay.map((d) => [d.day, d.total, `${group(d.requests)} requests`])), '');
  lines.push(
    'Main conversation vs subagents:',
    ...table([
      ['main conversation', rep.byRole.main.total, `${group(rep.byRole.main.requests)} requests`],
      ['subagents', rep.byRole.subagents.total, `${group(rep.byRole.subagents.requests)} requests`],
    ]),
    '',
  );
  if (rep.topSessions.length) {
    lines.push('Top sessions (by tokens):');
    rep.topSessions.forEach((s, i) => lines.push(`  ${i + 1}. ${s.id}  ${group(s.tokens)} tokens (${formatPercent(s.share)}), ${group(s.requests)} requests, ${group(s.subagentTokens)} in subagents`));
    lines.push('');
  }
  lines.push(`Where the tokens go (non-native checks D1–D6, ${ESTIMATED_NOT_MEASURED}; the checks overlap, so the shares do not add up):`);
  for (const c of rep.checks) {
    lines.push(`  ${c.id} ${c.name}: about ${group(c.tokens)} tokens (${formatPercent(c.share)})`);
    lines.push(`     ${c.basis}`);
    for (const e of c.evidence) {
      const at = e.file ? `${e.file}:${e.line ?? 1}` : null;
      lines.push(`     evidence: ${e.note}${at && !e.note.includes(at) ? ` (${at})` : ''}`);
    }
  }
  lines.push('');
  if (rep.improvements.length) {
    lines.push('How to improve (ranked as in import-usage; every item is an estimate until compare measures it):');
    for (const h of rep.improvements) {
      lines.push(`  ${h.rank}. [${h.nativeRow ? 'native /usage row' : `${h.source}, not native`}] ${h.change}`);
      lines.push(`     ${effectText(h.effect)} – ${h.label}${h.tokenShare === null ? '' : `; the check behind it covers about ${formatPercent(h.tokenShare)} of your tokens`}`);
      for (const e of h.evidence) {
        const at = e.file ? `${e.file}:${e.line ?? 1}` : null;
        lines.push(`     evidence: ${e.note}${at && !e.note.includes(at) ? ` (${at})` : ''}`);
      }
      lines.push(`     patch: ${h.patch}`);
      lines.push(`     try: ${h.compare}`);
    }
  } else lines.push(`How to improve: the checks found no change to suggest (${ESTIMATED_NOT_MEASURED}).`);
  const i = rep.inputs;
  lines.push(
    '',
    `Read: ${i.source === 'project-folder' ? "Claude Code's project folder of this repository" : 'the folder given to --read-transcripts'} – ${i.sessionFiles} session files and ${i.subagentFiles} subagent files (usage fields only; ${i.requests} requests in the window, ${i.requestsOutsideWindow} older, ${i.undatedRequests} undated; ${i.unknownRecords} records of other types and ${i.malformedLines} malformed lines skipped); ${i.configFiles} config files; ${i.usageRows} pasted /usage rows.`,
    'Token counts are sums of the usage fields in your records; the shares and fixes are estimates to test with compare. Nothing was stored.',
    MEASURING_QUALIFIER,
  );
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON schema of `usage --json` (subset of draft 2020-12 that validate.ts supports). A non-record output.

const count = { type: 'integer', minimum: 0 } as const;
const share = { type: 'number', minimum: 0, maximum: 1 } as const;
const tokens = { type: 'number', minimum: 0 } as const;
const componentProps = { input: tokens, cacheWrite5m: tokens, cacheWrite1h: tokens, cacheRead: tokens, output: tokens, total: tokens } as const;
const componentKeys = Object.keys(componentProps);
const evidence = {
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: { note: { type: 'string', maxLength: 400 }, file: { type: 'string', maxLength: 300 }, line: { type: 'integer', minimum: 1 } },
} as const;
const effect = {
  oneOf: [
    { type: 'object', required: ['kind', 'share'], additionalProperties: false, properties: { kind: { enum: ['applies-to', 'estimate'] }, share } },
    { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'unknown' } } },
  ],
} as const;
const withComponents = (extra: Record<string, unknown>, keys: string[]) => ({
  type: 'object',
  required: [...componentKeys, ...keys],
  additionalProperties: false,
  properties: { ...componentProps, ...extra },
});

export const tokenUsageSchemaV1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://crafthall.dev/schemas/optimize/token-usage-1.json',
  title: 'crafthall-optimize usage --json (format 1)',
  type: 'object',
  required: ['kind', 'format', 'summary', 'label', 'window', 'totals', 'byModel', 'byDay', 'byRole', 'topSessions', 'checks', 'improvements', 'inputs'],
  additionalProperties: false,
  properties: {
    kind: { const: TOKEN_USAGE_KIND },
    format: { const: TOKEN_USAGE_FORMAT },
    summary: { type: 'string', minLength: 1 },
    label: { const: ESTIMATED_NOT_MEASURED },
    window: {
      type: 'object',
      required: ['days', 'from', 'to'],
      additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 1, maximum: MAX_USAGE_DAYS }, from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' } },
    },
    totals: withComponents({}, []),
    byModel: { type: 'array', items: withComponents({ model: { type: 'string', minLength: 1, maxLength: 100 }, requests: count }, ['model', 'requests']) },
    byDay: { type: 'array', items: withComponents({ day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, requests: count }, ['day', 'requests']) },
    byRole: {
      type: 'object',
      required: ['main', 'subagents'],
      additionalProperties: false,
      properties: { main: withComponents({ requests: count }, ['requests']), subagents: withComponents({ requests: count }, ['requests']) },
    },
    topSessions: {
      type: 'array',
      maxItems: TOP_SESSIONS,
      items: {
        type: 'object',
        required: ['id', 'requests', 'tokens', 'share', 'subagentTokens'],
        additionalProperties: false,
        properties: { id: { type: 'string', pattern: '^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-\\d+)$' }, requests: count, tokens, share, subagentTokens: tokens },
      },
    },
    checks: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['id', 'name', 'tokens', 'share', 'label', 'basis', 'evidence'],
        additionalProperties: false,
        properties: {
          id: { enum: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] },
          name: { type: 'string' },
          tokens: count,
          share,
          label: { const: ESTIMATED_NOT_MEASURED },
          basis: { type: 'string' },
          evidence: { type: 'array', maxItems: MAX_EVIDENCE, items: evidence },
        },
      },
    },
    improvements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rank', 'id', 'source', 'nativeRow', 'change', 'effect', 'label', 'tokenShare', 'note', 'evidence', 'patch', 'compare'],
        additionalProperties: false,
        properties: {
          rank: { type: 'integer', minimum: 1 },
          id: { type: 'string' },
          source: { enum: ['native', 'D2', 'D3', 'D5', 'D6'] },
          nativeRow: { type: 'boolean' },
          change: { type: 'string' },
          effect,
          label: { enum: ['estimated, not measured', 'estimated, not measurable'] },
          tokenShare: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          note: { type: 'string' },
          evidence: { type: 'array', items: evidence },
          patch: { type: 'string' },
          compare: { type: 'string', pattern: ' compare --change \\S+\\.patch --plan-only$' },
        },
      },
    },
    inputs: {
      type: 'object',
      required: ['source', 'sessionFiles', 'subagentFiles', 'requests', 'requestsOutsideWindow', 'undatedRequests', 'unknownRecords', 'malformedLines', 'configFiles', 'usageRows'],
      additionalProperties: false,
      properties: {
        source: { enum: ['project-folder', 'read-transcripts'] },
        sessionFiles: count,
        subagentFiles: count,
        requests: count,
        requestsOutsideWindow: count,
        undatedRequests: count,
        unknownRecords: count,
        malformedLines: count,
        configFiles: count,
        usageRows: count,
      },
    },
  },
} as const;
