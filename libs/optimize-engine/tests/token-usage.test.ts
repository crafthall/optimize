// `usage` (R1-20): token totals by hand over the session fixtures of three Claude Code versions, splits that sum
// to the total, the window, the shares behind D1–D6 by hand, the --json schema, and fast-check properties: component
// totals never exceed the raw usage fields, and no prompt, tool or config text, path or identity reaches the output.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildTokenUsage,
  emptyTranscriptStats,
  formatTokenUsage,
  outputLeaks,
  readSessionFields,
  tokenUsageSchemaV1,
  validateAgainst,
  windowSession,
  type ConfigFile,
  type TokenComponents,
  type TokenUsageInput,
  type TokenUsageReport,
  type UsageSession,
} from '../src/index';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'sessions');
const VERSIONS = ['v2.1.321', 'v2.1.326', 'v2.1.330'];
const NOW = new Date('2026-11-27T00:00:00Z');

const load = (subagentOf?: Record<string, string>) => {
  const stats = emptyTranscriptStats();
  const sessions: UsageSession[] = VERSIONS.map((v, i) => ({
    id: subagentOf?.[v] ?? `session-${i + 1}`,
    subagent: subagentOf?.[v] !== undefined,
    fields: readSessionFields(readFileSync(join(FIXTURES, `${v}.jsonl`), 'utf8'), stats),
  }));
  stats.sessions = sessions.length;
  return { sessions, stats };
};

const input = (over: Partial<TokenUsageInput> = {}): TokenUsageInput => {
  const { sessions, stats } = load();
  return { sessions, stats, now: NOW, days: 7, source: 'read-transcripts', usage: null, config: [], identities: [], bin: 'crafthall-optimize', ...over };
};

const sumOf = (rows: readonly TokenComponents[]): TokenComponents =>
  rows.reduce(
    (a, r) => ({ input: a.input + r.input, cacheWrite5m: a.cacheWrite5m + r.cacheWrite5m, cacheWrite1h: a.cacheWrite1h + r.cacheWrite1h, cacheRead: a.cacheRead + r.cacheRead, output: a.output + r.output, total: a.total + r.total }),
    { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, total: 0 },
  );
const pick = (c: TokenComponents): TokenComponents => ({ input: c.input, cacheWrite5m: c.cacheWrite5m, cacheWrite1h: c.cacheWrite1h, cacheRead: c.cacheRead, output: c.output, total: c.total });

describe('usage totals: hand sums over the 2.1.321 / 2.1.326 / 2.1.330 fixtures', () => {
  // Per file (generate.mjs): 8 requests after requestId dedup; input 5 each; writes 30,000 on requests 0, 3, 5, 7 and
  // 800 on the other four; reads 30,000 on requests 1–7; output 400 each. 2.1.321 has no TTL split (all 5m),
  // 2.1.326 writes at 5m, 2.1.330 at 1h. All on claude-opus-5-5, 2026-11-20 09:00–11:00 UTC.
  const perFile = { input: 8 * 5, writes: 4 * 30_000 + 4 * 800, read: 7 * 30_000, output: 8 * 400 };
  const fileTotal = perFile.input + perFile.writes + perFile.read + perFile.output; // 336,440
  const rep = buildTokenUsage(input());

  it('totals by component equal the hand sum', () => {
    expect(fileTotal).toBe(336_440);
    expect(rep.totals).toEqual({ input: 120, cacheWrite5m: 2 * 123_200, cacheWrite1h: 123_200, cacheRead: 630_000, output: 9_600, total: 1_009_320 });
    expect(rep.inputs).toMatchObject({ requests: 24, requestsOutsideWindow: 0, undatedRequests: 0, sessionFiles: 3, subagentFiles: 0, malformedLines: 3 });
  });

  it('per-model, per-day, main/subagent and per-session splits sum to the total', () => {
    expect(rep.byModel.map((m) => [m.model, m.requests])).toEqual([['claude-opus-5-5', 24]]);
    expect(rep.byDay.map((d) => [d.day, d.requests])).toEqual([['2026-11-20', 24]]);
    expect(sumOf(rep.byModel)).toEqual(rep.totals);
    expect(sumOf(rep.byDay)).toEqual(rep.totals);
    expect(sumOf([rep.byRole.main, rep.byRole.subagents])).toEqual(rep.totals);
    expect(rep.byRole.subagents.total).toBe(0);
    expect(rep.topSessions.map((s) => [s.id, s.tokens, s.requests])).toEqual([
      ['session-1', fileTotal, 8],
      ['session-2', fileTotal, 8],
      ['session-3', fileTotal, 8],
    ]);
    expect(rep.topSessions.reduce((a, s) => a + s.tokens, 0)).toBe(rep.totals.total);
  });

  it('a subagent file counts under subagents and under its parent session; D1 counts its Opus tokens', () => {
    const { sessions, stats } = load({ 'v2.1.330': 'session-1' });
    const r = buildTokenUsage(input({ sessions, stats }));
    expect(r.totals.total).toBe(1_009_320);
    expect(r.byRole.subagents).toMatchObject({ total: fileTotal, requests: 8 });
    expect(r.byRole.main).toMatchObject({ total: 2 * fileTotal, requests: 16 });
    expect(r.topSessions[0]).toMatchObject({ id: 'session-1', tokens: 2 * fileTotal, subagentTokens: fileTotal, requests: 16 });
    expect(r.checks.find((c) => c.id === 'D1')!.tokens).toBe(fileTotal);
    expect(r.inputs).toMatchObject({ sessionFiles: 2, subagentFiles: 1 });
  });

  it('the window keeps only requests at or after now − days', () => {
    const r = buildTokenUsage(input({ days: 1 }));
    expect(r.totals.total).toBe(0);
    expect(r.inputs).toMatchObject({ requests: 0, requestsOutsideWindow: 24 });
    expect(r.summary).toBe('No requests in the last 1 day in the session records read (24 older, 0 undated); try a larger --days');
    // 2026-11-20T10:00Z cuts 09:00 + {0.2, 1, 2, 12, 13, 40, 41} min and keeps the request at 11:00 (one per file).
    const cut = buildTokenUsage(input({ now: new Date('2026-11-21T10:00:00Z'), days: 1 }));
    expect(cut.inputs.requests).toBe(3);
    expect(cut.totals).toMatchObject({ input: 15, cacheRead: 90_000, output: 1_200, total: 3 * (5 + 30_000 + 30_000 + 400) });
  });
});

describe('shares behind D1–D6 (hand cases, estimated, not measured)', () => {
  const dup = 'Always run the full test suite before you open a pull request in this repository.'; // 81 characters
  const config: ConfigFile[] = [
    { path: 'CLAUDE.md', text: `${'x'.repeat(318)}\n${dup}\n` }, // 401 characters
    { path: '.claude/rules/tests.md', text: `${dup}\n` }, // 82 characters
    { path: '.claude/agents/helper.md', text: '---\nname: helper\ndescription: helps with things\n---\nBody\n' },
    { path: '.mcp.json', text: '{\n  "mcpServers": { "a": {}, "b": {} }\n}\n' },
  ];
  const rep = buildTokenUsage(input({ config }));
  const share = (id: string) => rep.checks.find((c) => c.id === id)!;

  it('D2 per TTL (as checkD2): writes after the 10- and 27-minute gaps on the 5m files, reads after them on the 1h file', () => {
    // 2.1.321 (no split, 5m) and 2.1.326 (5m): writes of requests 3 and 5 = 2 × 30,000 each; 2.1.330 (1h): reads of
    // requests 3 and 5 = 2 × 30,000. Same sum as before, different parts: 120,000 + 60,000.
    expect(share('D2').tokens).toBe(2 * 2 * 30_000 + 2 * 30_000);
    expect(share('D2').share).toBeCloseTo(180_000 / 1_009_320, 12);
  });

  it('D3: no cache miss in the fixtures (only the first request reads nothing)', () => {
    expect(share('D3').tokens).toBe(0);
  });

  it('D4: always-loaded files and descriptions, chars ÷ 4 × 1.3 (Opus 5.5) per main request', () => {
    // 401 + 82 characters of always-loaded files + 17 of the agent description = 500 → ceil(500 / 4) = 125 tokens.
    expect(share('D4').tokens).toBe(Math.round(125 * 1.3 * 24));
    expect(share('D4').evidence.map((e) => `${e.file}:${e.line}`)).toEqual(['.mcp.json:2', 'CLAUDE.md:1', '.claude/rules/tests.md:1', '.claude/agents/helper.md:3']);
  });

  it('D5: one redundant copy of an 81-character line, ceil(81 / 4) = 21 tokens × 1.3 per main request', () => {
    expect(share('D5').tokens).toBe(Math.round(21 * 1.3 * 24));
    expect(share('D5').evidence[0]).toMatchObject({ file: 'CLAUDE.md', line: 2 });
  });

  it('D6: four 20,460-character Bash results per file, × 1.3, carried by 6 + 4 + 2 + 1 later requests', () => {
    expect(share('D6').tokens).toBe(Math.round(3 * (20_460 / 4) * 1.3 * 13));
  });

  it('every share is between 0 and 1 and labelled; the fixes carry the token share of their check', () => {
    for (const c of rep.checks) {
      expect(c.share).toBeGreaterThanOrEqual(0);
      expect(c.share).toBeLessThanOrEqual(1);
      expect(c.label).toBe('estimated, not measured');
    }
    const d6 = rep.improvements.find((h) => h.source === 'D6')!;
    expect(d6.tokenShare).toBe(share('D6').share);
    expect(d6.compare).toBe('crafthall-optimize compare --change optimize-D6-bash-output-filter.patch --plan-only');
  });

  it('the fixes are exactly the import-usage list (ranks, ids, effects, labels unchanged)', async () => {
    const { buildHypotheses } = await import('../src/index');
    const { sessions, stats } = load();
    const hyp = buildHypotheses({ usage: null, config, transcripts: { sessions: sessions.map((s) => s.fields), stats }, identities: [], bin: 'crafthall-optimize' });
    expect(rep.improvements.map((h) => [h.rank, h.id, h.effect, h.label])).toEqual(hyp.hypotheses.map((h) => [h.rank, h.id, h.effect, h.label]));
  });

  it('text output: summary first, every section, the qualifier last', () => {
    const lines = formatTokenUsage(rep);
    expect(lines[0]).toBe('1,009,320 tokens in the last 7 days: 3 sessions, 24 requests (counted from your session records; the shares behind the checks and the fixes are estimated, not measured)');
    for (const h of ['Tokens by component:', 'By model:', 'By day (UTC):', 'Main conversation vs subagents:', 'Top sessions (by tokens):']) expect(lines).toContain(h);
    expect(lines.join('\n')).toMatch(/How to improve \(ranked as in import-usage/);
    expect(lines.join('\n')).toContain('  total                1,009,320  100.0%');
    expect(lines.at(-1)).toMatch(/^Comparisons run on your own Claude account/);
  });

  it('--json validates against tokenUsageSchemaV1; a broken report does not (not vacuous)', () => {
    expect(validateAgainst(tokenUsageSchemaV1, JSON.parse(JSON.stringify(rep)))).toEqual([]);
    const broken = { ...rep, totals: { ...rep.totals, total: -1 }, extra: 1 } as unknown as TokenUsageReport;
    expect(validateAgainst(tokenUsageSchemaV1, broken).length).toBeGreaterThanOrEqual(2);
  });
});

describe('windowSession', () => {
  it('drops undated and older requests and remaps the chain indexes', () => {
    const r = (t: number) => ({ t, sidechain: false, input: 1, write5m: 0, write1h: 0, read: 0, output: 0, model: null });
    const w = windowSession({ requests: [r(NaN), r(1), r(5), r(9)], toolResults: [{ t: 4, bash: true, chars: 1, later: [2, 3] }, { t: 0, bash: true, chars: 1, later: [1, 2, 3] }], ttlSplit: false }, 3);
    expect(w.requests.map((q) => q.t)).toEqual([5, 9]);
    expect(w.toolResults).toEqual([{ t: 4, bash: true, chars: 1, later: [0, 1] }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Properties

const SENTINELS = ['SENTINEL-PROMPT-TEXT-x7', 'sk-ant-api03-SENTINELSECRET0000000000', '/Users/zelda/private/notes.txt', 'Zelda Quist', 'zelda@example.org'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-2', '<synthetic>', 'not a model id!'];

const usageArb = fc.record({ input_tokens: fc.nat(5_000), cache_creation_input_tokens: fc.nat(50_000), cache_read_input_tokens: fc.nat(200_000), output_tokens: fc.nat(4_000) });
const recordArb = fc.record({
  kind: fc.constantFrom('assistant', 'assistant', 'user', 'summary'),
  rid: fc.integer({ min: 0, max: 5 }),
  minute: fc.integer({ min: 0, max: 20 * 24 * 60 }),
  sidechain: fc.boolean(),
  split: fc.constantFrom('none', '5m', '1h'),
  model: fc.constantFrom(...MODELS),
  usage: usageArb,
  text: fc.constantFrom(...SENTINELS),
  chars: fc.nat(30_000),
});
const sessionArb = fc.array(recordArb, { maxLength: 25 });

/** One JSON Lines file from generated records; also the raw sum of every usage field of every assistant line. */
type Rec = typeof recordArb extends fc.Arbitrary<infer T> ? T : never;
function toJsonl(recs: readonly Rec[]) {
  const raw = { input: 0, write: 0, read: 0, output: 0 };
  const lines = recs.map((r, i) => {
    const timestamp = new Date(Date.UTC(2026, 10, 7) + r.minute * 60_000).toISOString();
    if (r.kind === 'assistant') {
      raw.input += r.usage.input_tokens;
      raw.write += r.usage.cache_creation_input_tokens;
      raw.read += r.usage.cache_read_input_tokens;
      raw.output += r.usage.output_tokens;
      const w = r.usage.cache_creation_input_tokens;
      const usage = { ...r.usage, ...(r.split === 'none' ? {} : { cache_creation: r.split === '1h' ? { ephemeral_1h_input_tokens: w, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: w } }) };
      return JSON.stringify({ type: 'assistant', uuid: `a${i}`, parentUuid: i ? `a${i - 1}` : null, requestId: `req_${r.rid}`, timestamp, isSidechain: r.sidechain, cwd: SENTINELS[2], message: { model: r.model, content: [{ type: 'text', text: r.text }, { type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: { command: r.text } }], usage } });
    }
    if (r.kind === 'user')
      return JSON.stringify({ type: 'user', uuid: `a${i}`, parentUuid: i ? `a${i - 1}` : null, timestamp, isSidechain: r.sidechain, message: { content: [{ type: 'tool_result', tool_use_id: `tu_${i - 1}`, content: r.text.repeat(Math.ceil(r.chars / r.text.length)) }] } });
    return JSON.stringify({ type: r.kind, summary: r.text, timestamp });
  });
  return { jsonl: lines.join('\n'), raw };
}

describe('properties (fast-check)', () => {
  it('component totals never exceed the sum of the raw usage fields; every split sums to the total; shares in [0, 1]', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(sessionArb, fc.boolean()), { minLength: 1, maxLength: 4 }), fc.integer({ min: 1, max: 30 }), (files, days) => {
        const stats = emptyTranscriptStats();
        const raw = { input: 0, write: 0, read: 0, output: 0 };
        const sessions = files.map(([recs, subagent], i) => {
          const f = toJsonl(recs);
          for (const k of Object.keys(raw) as (keyof typeof raw)[]) raw[k] += f.raw[k];
          return { id: `session-${(i % 2) + 1}`, subagent, fields: readSessionFields(f.jsonl, stats) };
        });
        const rep = buildTokenUsage({ sessions, stats, now: NOW, days, source: 'read-transcripts', usage: null, config: [], identities: [], bin: 'crafthall-optimize' });
        const t = rep.totals;
        expect(t.input).toBeLessThanOrEqual(raw.input);
        expect(t.cacheWrite5m + t.cacheWrite1h).toBeLessThanOrEqual(raw.write);
        expect(t.cacheRead).toBeLessThanOrEqual(raw.read);
        expect(t.output).toBeLessThanOrEqual(raw.output);
        expect(t.total).toBe(t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output);
        expect(t.total).toBeLessThanOrEqual(raw.input + raw.write + raw.read + raw.output);
        expect(pick(sumOf(rep.byModel))).toEqual(t);
        expect(pick(sumOf(rep.byDay))).toEqual(t);
        expect(pick(sumOf([rep.byRole.main, rep.byRole.subagents]))).toEqual(t);
        expect(rep.topSessions.reduce((a, s) => a + s.tokens, 0)).toBeLessThanOrEqual(t.total);
        for (const c of rep.checks) {
          expect(c.tokens).toBeLessThanOrEqual(t.total);
          expect(c.share).toBeGreaterThanOrEqual(0);
          expect(c.share).toBeLessThanOrEqual(1);
        }
        expect(validateAgainst(tokenUsageSchemaV1, JSON.parse(JSON.stringify(rep)))).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('no prompt, tool or config text, absolute path or identity reaches the report or its text', () => {
    fc.assert(
      fc.property(sessionArb, fc.constantFrom(...SENTINELS), (recs, planted) => {
        const stats = emptyTranscriptStats();
        const sessions = [{ id: 'session-1', subagent: false, fields: readSessionFields(toJsonl(recs).jsonl, stats) }];
        const config: ConfigFile[] = [
          { path: 'CLAUDE.md', text: `# Rules\n${planted}\nAlways run the full test suite before you open a pull request in this repository.\n` },
          { path: '.claude/rules/a.md', text: `Always run the full test suite before you open a pull request in this repository.\n${planted}\n` },
          { path: '.claude/agents/x.md', text: `---\nname: x\ndescription: ${planted}\nmodel: ${planted}\n---\n` },
          { path: '.claude/settings.json', text: JSON.stringify({ model: planted, env: { DISABLE_PROMPT_CACHING: '1' } }) },
        ];
        const identities = ['Zelda Quist', 'zelda@example.org'];
        const rep = buildTokenUsage({ sessions, stats, now: NOW, days: 30, source: 'read-transcripts', usage: null, config, identities, repoRoot: '/Users/zelda/work/repo', home: '/Users/zelda', bin: 'crafthall-optimize' });
        expect(config.map((c) => c.text).join('\n')).toContain(planted); // positive control: the input holds it
        const text = `${JSON.stringify(rep)}\n${formatTokenUsage(rep).join('\n')}`;
        for (const s of SENTINELS) expect(text).not.toContain(s);
        expect(text).not.toContain('/Users/');
        expect(outputLeaks(rep, identities)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});

// QA (§13 of stats-review-1031.md): every threshold ±1 ms / ±1 character, the per-request caps, and the
// D6 wording for a result with no later request.
describe('thresholds and caps (#1166)', () => {
  const T = Date.parse('2026-11-26T00:00:00Z');
  const req = (t: number, over: Partial<{ input: number; write5m: number; write1h: number; read: number; output: number; sidechain: boolean; model: string | null }> = {}) => ({
    t,
    sidechain: false,
    input: 10,
    write5m: 100,
    write1h: 0,
    read: 1_000,
    output: 1,
    model: 'claude-sonnet-4-5' as string | null,
    ...over,
  });
  const one = (requests: ReturnType<typeof req>[], toolResults: { t: number; bash: boolean; chars: number; later?: number[] }[] = [], config: ConfigFile[] = [], now = new Date(T + DAY)) =>
    buildTokenUsage({ sessions: [{ id: 'session-1', subagent: false, fields: { requests, toolResults, ttlSplit: true } }], stats: emptyTranscriptStats(), now, days: 1, source: 'read-transcripts', usage: null, config, identities: [], bin: 'crafthall-optimize' });
  const DAY = 86_400_000;
  const MIN = 60_000;
  const check = (r: TokenUsageReport, id: string) => r.checks.find((c) => c.id === id)!;

  it('window: a request exactly at now − days is kept, 1 ms earlier is older, an undated one is counted apart', () => {
    const r = one([req(T - 1), req(T), req(NaN)]);
    expect(r.inputs).toMatchObject({ requests: 1, requestsOutsideWindow: 1, undatedRequests: 1 });
    expect(r.totals.total).toBe(10 + 100 + 1_000 + 1);
  });

  it('D2: a gap of exactly 5 min is not idle, 5 min + 1 ms is; 60 min is, 60 min + 1 ms is not', () => {
    const writesAfter = (gap: number) => check(one([req(T), req(T + gap, { write5m: 700 })]), 'D2').tokens;
    expect(writesAfter(5 * MIN)).toBe(0);
    expect(writesAfter(5 * MIN + 1)).toBe(700);
    expect(writesAfter(60 * MIN)).toBe(700);
    expect(writesAfter(60 * MIN + 1)).toBe(0);
  });

  it('D3: a miss within the previous TTL counts input + writes; 1 ms past the TTL is no miss; a read is no miss', () => {
    const miss = (gap: number, prev: Partial<Parameters<typeof req>[1]> = {}, next: Partial<Parameters<typeof req>[1]> = {}) =>
      check(one([req(T, prev), req(T + gap, { read: 0, write5m: 500, ...next })]), 'D3').tokens;
    expect(miss(5 * MIN)).toBe(510);
    expect(miss(5 * MIN + 1)).toBe(0);
    expect(miss(60 * MIN, { write5m: 0, write1h: 100 }, { write5m: 0, write1h: 500 })).toBe(510);
    expect(miss(60 * MIN + 1, { write5m: 0, write1h: 100 }, { write5m: 0, write1h: 500 })).toBe(0);
    expect(miss(MIN, {}, { read: 1 })).toBe(0);
  });

  it('D2 on a 1h-TTL session counts the reads after a mid gap, not the new turn it writes (Lead follow-up 1)', () => {
    const r = one([req(T, { write5m: 0, write1h: 100 }), req(T + 10 * MIN, { write5m: 0, write1h: 700, read: 2_000 })]);
    expect(check(r, 'D2').tokens).toBe(2_000); // was 700 (the 1h write)
    expect(check(r, 'D2').basis).toContain('cache reads on 1h-TTL sessions (1)');
  });

  it('D6 is capped at each carrying request’s input side (Lead follow-up 2)', () => {
    // 20,001 characters on Sonnet 4.5 = 5,000.25 tokens; the one later request has an input side of 1 + 0 + 50 = 51.
    const r = one([req(T, { read: 100_000 }), req(T + 2, { input: 1, write5m: 0, read: 50 })], [{ t: T + 1, bash: true, chars: 20_001, later: [1] }]);
    expect(check(r, 'D6').tokens).toBe(51); // was 5,000
  });

  it('D6: 20,000 characters is not large, 20,001 is; with no later request it counts once and says so', () => {
    const d6 = (chars: number) => check(one([req(T, { read: 100_000 })], [{ t: T + 1, bash: true, chars, later: [] }]), 'D6'); // total 100,111 stays above the share
    expect(d6(20_000).tokens).toBe(0);
    expect(d6(20_001).tokens).toBe(Math.round(20_001 / 4)); // Sonnet 4.5: tokenizer factor 1
    expect(d6(20_001).basis).toContain('at least once');
  });

  it('D4 and D5 are capped at each main request’s input side; with no requests every share is 0', () => {
    const big: ConfigFile[] = [{ path: 'CLAUDE.md', text: `${'y'.repeat(40_000)}\n` }];
    const r = one([req(T, { input: 3, write5m: 0, read: 0 })], [], big);
    expect(check(r, 'D4').tokens).toBe(3);
    const empty = one([], [], big);
    expect(empty.totals.total).toBe(0);
    for (const c of empty.checks) expect([c.tokens, c.share]).toEqual([0, 0]);
  });
});
