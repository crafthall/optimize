//: the import-usage estimate refinements of the QA review (stats-review-1031.md §10 items 1, 7, 9).
// Hand cases (each failed before the change, the old value is in the comment) and a fast-check law that the ranking is
// unchanged when the estimate inputs are unchanged. Weights: platform.claude.com pricing and prompt-caching pages
// (accessed 2026-11-26) – read 0.05x on Opus/Sonnet 5.5, 0.025x on Fable/Mythos 5.1–5.2, 0.1x otherwise; the Opus 4.7+
// tokenizer counts about 30% more tokens (NEW_TOKENIZER_FACTOR 1.3, an estimate).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildHypotheses,
  checkD2,
  checkD5,
  checkD6,
  DEFAULT_MODEL_WEIGHTS,
  modelWeights,
  NEW_TOKENIZER_FACTOR,
  readSessionFields,
  requestUnits,
  type ConfigFile,
} from '../src/index';
import type { RequestFields, SessionFields, ToolResultFields } from '../src/transcripts';

const MIN = 60_000;
const req = (t: number, f: Partial<RequestFields>): RequestFields => ({ t, sidechain: false, input: 0, write5m: 0, write1h: 0, read: 0, output: 0, ...f });
const session = (requests: RequestFields[], toolResults: ToolResultFields[] = []): SessionFields => ({ requests, toolResults, ttlSplit: true });
const shareOf = (d: { effect: { kind: string; share?: number } } | undefined): number => (d && d.effect.kind === 'estimate' ? d.effect.share! : NaN);

describe('#1123 – per-model weights', () => {
  it.each([
    ['claude-opus-5-5', 0.05, 1.3],
    ['claude-sonnet-5-5', 0.05, 1.3],
    ['claude-fable-5-2', 0.025, 1.3],
    ['claude-fable-5-1', 0.025, 1.3],
    ['claude-mythos-5-2', 0.025, 1.3],
    ['claude-fable-5', 0.1, 1.3],
    ['claude-opus-5', 0.1, 1.3],
    ['claude-opus-4-7', 0.1, 1.3],
    ['claude-sonnet-5', 0.1, 1.3],
    ['claude-haiku-5-5', 0.1, 1.3],
    ['claude-opus-4-6', 0.1, 1],
    ['claude-sonnet-4-6', 0.1, 1],
    ['claude-haiku-4-5-20251001', 0.1, 1],
    ['claude-sonnet-4-20250514', 0.1, 1],
    ['claude-3-5-sonnet-20241022', 0.1, 1],
    ['us.anthropic.claude-opus-5-5', 0.05, 1.3],
  ])('%s → read %sx, tokenizer %sx', (model, read, tokenizer) => {
    expect(modelWeights(model)).toEqual({ read, tokenizer });
  });

  it('an unknown model falls back to the documented default (the pre-#1123 weights)', () => {
    expect(DEFAULT_MODEL_WEIGHTS).toEqual({ read: 0.1, tokenizer: 1 });
    for (const m of [null, undefined, '<synthetic>', 'claude-next', 'gpt-4o']) expect(modelWeights(m)).toEqual(DEFAULT_MODEL_WEIGHTS);
    expect(NEW_TOKENIZER_FACTOR).toBe(1.3);
  });

  it('read-heavy request (100k read, 3k 5m write, 1k output): 13,750 units on Opus 5.5 (was 18,750 at a flat 0.1x)', () => {
    const r = { read: 100_000, write5m: 3_000, output: 1_000 };
    expect(requestUnits(req(0, { ...r, model: 'claude-opus-5-5' }))).toBe(13_750);
    expect(requestUnits(req(0, { ...r, model: 'claude-fable-5-2' }))).toBe(11_250);
    expect(requestUnits(req(0, r))).toBe(18_750);
  });
});

describe('#1123 – D2 with each request read at its own model weight', () => {
  // The 5m → 1h hand case: W₅ = 81,500, R = 41,000.
  const fiveMin = (model?: string): SessionFields =>
    session([
      req(0, { input: 10, write5m: 40_000, output: 800, model }),
      req(12 * MIN, { input: 10, write5m: 41_000, output: 900, model }),
      req(13 * MIN, { input: 10, write5m: 500, read: 41_000, output: 200, model }),
    ]);

  it('5m → 1h on Opus 5.5: (1.95·R − 0.75·W₅) ÷ total = 18,825 ÷ 113,455 (was 16,775 ÷ 115,505)', () => {
    expect(shareOf(checkD2([fiveMin('claude-opus-5-5')])[0])).toBeCloseTo(18_825 / 113_455, 12);
  });

  it('5m → 1h on Fable 5.2: (1.975·R − 0.75·W₅) ÷ total = 19,850 ÷ 112,430', () => {
    expect(shareOf(checkD2([fiveMin('claude-fable-5-2')])[0])).toBeCloseTo(19_850 / 112_430, 12);
  });

  it('an unknown model keeps the #1116 number: 16,775 ÷ 115,505', () => {
    expect(shareOf(checkD2([fiveMin('claude-next')])[0])).toBeCloseTo(16_775 / 115_505, 12);
  });

  it('1h → 5m on Opus 5.5: (0.75·W₁ − 1.2·R′) ÷ total = 63,750 ÷ 210,000 (was 64,250 ÷ 210,500)', () => {
    const m = 'claude-opus-5-5';
    const s = session([req(0, { write1h: 100_000, output: 1_000, model: m }), req(10 * MIN, { read: 10_000, write1h: 1_000, output: 500, model: m })]);
    expect(shareOf(checkD2([s])[0])).toBeCloseTo(63_750 / 210_000, 12);
  });

  it('a mixed session weights each request by its own model', () => {
    // R = 41,000 on the Sonnet 5.5 request (0.05x); W₅ = 81,500. Δ = 41,000·1.95 − 61,125 = 18,825.
    // Total = 1.25·81,500 + 0.05·41,000 + 30 + 9,500 = 113,455 (the read sits on the Sonnet 5.5 request).
    const s = fiveMin('claude-opus-4-6');
    s.requests[1] = { ...s.requests[1]!, model: 'claude-sonnet-5-5' };
    s.requests[2] = { ...s.requests[2]!, model: 'claude-sonnet-5-5' };
    expect(shareOf(checkD2([s])[0])).toBeCloseTo(18_825 / 113_455, 12);
  });
});

// Session records with parent links, as Claude Code writes them (`uuid`, `parentUuid`, `requestId`).
const ts = (s: number): string => new Date(Date.UTC(2026, 10, 20, 9, 0, s)).toISOString();
interface Rec {
  uuid: string;
  parent: string | null;
  at: number;
  kind: 'user' | 'assistant' | 'result' | 'compact';
  logicalParent?: string;
  bashId?: string;
  ttl?: '5m' | '1h';
  model?: string;
}
const line = (r: Rec): string => {
  const base = { uuid: r.uuid, parentUuid: r.parent, timestamp: ts(r.at), isSidechain: false, sessionId: 's' };
  if (r.kind === 'compact') return JSON.stringify({ ...base, type: 'system', subtype: 'compact_boundary', logicalParentUuid: r.logicalParent });
  if (r.kind === 'user') return JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'x' } });
  if (r.kind === 'result')
    return JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tb1', content: 'y'.repeat(28_000) }] } });
  const split = r.ttl === '1h' ? { ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1_000 };
  return JSON.stringify({
    ...base,
    type: 'assistant',
    requestId: `req_${r.uuid}`,
    message: {
      id: `msg_${r.uuid}`,
      role: 'assistant',
      ...(r.model ? { model: r.model } : {}),
      content: r.bashId ? [{ type: 'tool_use', id: r.bashId, name: 'Bash', input: {} }] : [{ type: 'text', text: 'z' }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 20_000, output_tokens: 200, cache_creation: split },
    },
  });
};
/**
 * a1 runs Bash; its 28,000-char result x1 is followed on the same chain by a2, a3, a4. A rewind at a1 starts a sibling
 * branch b1 → a5 → a6, later in time but not on the result's chain. Six requests.
 */
const branched = (opts: { ttl?: '5m' | '1h'; model?: string; compactAfterA2?: boolean } = {}): string =>
  [
    { uuid: 'u0', parent: null, at: 0, kind: 'user' },
    { uuid: 'a1', parent: 'u0', at: 1, kind: 'assistant', bashId: 'tb1' },
    { uuid: 'x1', parent: 'a1', at: 2, kind: 'result' },
    { uuid: 'a2', parent: 'x1', at: 3, kind: 'assistant' },
    ...(opts.compactAfterA2 ? [{ uuid: 'cb', parent: null, at: 3, kind: 'compact' as const, logicalParent: 'a2' }] : []),
    { uuid: 'a3', parent: opts.compactAfterA2 ? 'cb' : 'a2', at: 4, kind: 'assistant' },
    { uuid: 'a4', parent: 'a3', at: 5, kind: 'assistant' },
    { uuid: 'b1', parent: 'a1', at: 6, kind: 'user' },
    { uuid: 'a5', parent: 'b1', at: 7, kind: 'assistant' },
    { uuid: 'a6', parent: 'a5', at: 8, kind: 'assistant' },
  ]
    .map((r) => line({ ttl: opts.ttl, model: opts.model, ...r } as Rec))
    .join('\n');

describe('#1123 – D6 on the result\'s own chain, at the session TTL, with the model tokenizer', () => {
  it('the reader links the result to the 3 later requests on its chain, not the 2 on the rewound branch', () => {
    const s = readSessionFields(branched());
    expect(s.requests).toHaveLength(6);
    const big = s.toolResults.find((r) => r.chars === 28_000)!;
    expect(big.bash).toBe(true);
    expect(big.later!.map((i) => s.requests[i]!.t)).toEqual([3, 4, 5].map((x) => Date.parse(ts(x))));
  });

  it('share = 5,000·(1.25 + 0.1·2) ÷ (6 × 4,260) = 7,250 ÷ 25,560 (was 8,250: the branch counted as re-reads)', () => {
    expect(shareOf(checkD6([], [readSessionFields(branched())])[0])).toBe(7_250 / 25_560);
  });

  it('compaction is ignored explicitly: a compact boundary on the chain does not cut it (same 7,250 ÷ 25,560)', () => {
    const s = readSessionFields(branched({ compactAfterA2: true }));
    expect(s.toolResults.find((r) => r.chars === 28_000)!.later).toHaveLength(3);
    expect(shareOf(checkD6([], [s])[0])).toBe(7_250 / 25_560);
  });

  it('a 1h-TTL session writes the excess at 2x: 5,000·(2 + 0.2) = 11,000 ÷ (6 × 5,010) (was 8,250 ÷ 30,060)', () => {
    expect(shareOf(checkD6([], [readSessionFields(branched({ ttl: '1h' }))])[0])).toBe(11_000 / 30_060);
  });

  it('Opus 5.5: excess 5,000 × 1.3 = 6,500 tokens; 6,500·(1.25 + 0.05·2) = 8,775 ÷ (6 × 3,260) (was 8,250 ÷ 25,560)', () => {
    expect(shareOf(checkD6([], [readSessionFields(branched({ model: 'claude-opus-5-5' }))])[0])).toBeCloseTo(8_775 / 19_560, 12);
  });

  it('without parent links: later requests of the result\'s own sidechain flag only (6,750 ÷ 17,040; was 7,250)', () => {
    const r = (t: number, sidechain = false): RequestFields => req(t, { input: 10, write5m: 1_000, read: 20_000, output: 200, sidechain });
    const s = session([r(0), r(2, true), r(3), r(4)], [{ t: 1, bash: true, chars: 28_000, sidechain: false }]);
    expect(shareOf(checkD6([], [s])[0])).toBe(6_750 / 17_040);
  });
});

const DUP = 'Always run the full test suite before you open a pull request in this repository.';
const CONFIG: ConfigFile[] = [
  { path: 'CLAUDE.md', text: `# Project\n\n${DUP}\n` },
  { path: '.claude/rules/tests.md', text: `${DUP}\n` },
];

describe('#1123 – D5 with the model tokenizer and read weight', () => {
  const tokens = Math.ceil(DUP.length / 4); // 21 tokens at chars ÷ 4
  const heavy = { read: 100_000, write5m: 3_000, output: 1_000 };

  it('Opus 5.5: 21 × 1.3 tokens × 0.05 ÷ 13,750 (was 21 × 0.1 ÷ 18,750)', () => {
    expect(tokens).toBe(21);
    const [d] = checkD5(CONFIG, [session([req(0, { ...heavy, model: 'claude-opus-5-5' })])]);
    expect(shareOf(d)).toBeCloseTo((21 * 1.3 * 0.05) / 13_750, 12);
    expect(d!.note).toMatch(/^about 27 redundant tokens/);
  });

  it('an unknown model keeps 21 × 0.1 ÷ 18,750 and "about 21 redundant tokens"', () => {
    const [d] = checkD5(CONFIG, [session([req(0, heavy)])]);
    expect(shareOf(d)).toBeCloseTo((21 * 0.1) / 18_750, 12);
    expect(d!.note).toMatch(/^about 21 redundant tokens/);
  });
});

// Property: when the estimate inputs do not change, the ranking does not change. "Unchanged inputs" = the requests get a
// model id whose weights equal the default (Sonnet 4.6: read 0.1x, older tokenizer) and every Bash result gets explicit
// chain links equal to the time-based fallback set. The whole hypothesis list (ids, ranks, shares, labels) must be equal.
const requestArb = (t: number): fc.Arbitrary<RequestFields> =>
  fc.record({ t: fc.constant(t), sidechain: fc.boolean(), input: fc.nat(5_000), write5m: fc.nat(60_000), write1h: fc.nat(60_000), read: fc.nat(200_000), output: fc.nat(8_000) });
const sessionArb: fc.Arbitrary<SessionFields> = fc
  .array(fc.integer({ min: 0, max: 90 * MIN }), { minLength: 1, maxLength: 10 })
  .chain((gaps) => {
    const times = gaps.reduce<number[]>((a, g) => [...a, (a.at(-1) ?? 0) + g], []);
    return fc.record({
      requests: fc.tuple(...times.map(requestArb)),
      toolResults: fc.array(fc.record({ t: fc.integer({ min: 0, max: times.at(-1)! }), bash: fc.boolean(), chars: fc.integer({ min: 0, max: 200_000 }) }), { maxLength: 4 }),
      ttlSplit: fc.constant(true),
    });
  });

// QA review: model ids as Claude Code, Bedrock and Vertex write them.
describe('#1123 review – model id edge cases', () => {
  it.each([
    ['claude-opus-5-5[1m]', 0.05, 1.3], // 1M-context suffix
    ['claude-opus-4-7[1m]', 0.1, 1.3],
    ['claude-sonnet-4-6[1m]', 0.1, 1],
    ['CLAUDE-OPUS-5-5', 0.05, 1.3], // case
    ['anthropic.claude-fable-5-1-v1:0', 0.025, 1.3], // Bedrock
    ['claude-opus-4-7@20260416', 0.1, 1.3], // Vertex
    ['claude-opus-4-1-20250805', 0.1, 1], // dated id: minor 1, not the date
    ['claude-fable-5-10', 0.1, 1.3], // a two-digit minor is not 5.1
    ['claude-sonnet-5-50', 0.1, 1.3], // nor is 5.50 → 5.5
    ['claude-opus-6', 0.1, 1.3], // future id: standard read, newer tokenizer
    ['claude-mythos-preview', 0.1, 1.3], // pricing page: Mythos Preview uses the newer tokenizer (was factor 1)
    ['claude-3-7-sonnet-20250219', 0.1, 1],
    ['', 0.1, 1],
  ])('%s → read %sx, tokenizer %sx', (model, read, tokenizer) => {
    expect(modelWeights(model)).toEqual({ read, tokenizer });
  });

  it('the reader keeps <synthetic> and [1m] ids and drops free text', () => {
    const rec = (model: unknown, id: string) =>
      JSON.stringify({ type: 'assistant', uuid: id, timestamp: ts(1), requestId: id, message: { model, usage: { input_tokens: 1, output_tokens: 1 } } });
    const s = readSessionFields([rec('<synthetic>', 'r1'), rec('claude-opus-5-5[1m]', 'r2'), rec('not a model id', 'r3'), rec(42, 'r4')].join('\n'));
    expect(s.requests.map((r) => r.model)).toEqual(['<synthetic>', 'claude-opus-5-5[1m]', null, null]);
  });
});

// QA review, DEFECT (fixed: results of one request's calls share their later requests): parallel tool calls. Claude Code writes each tool_result with `parentUuid` = its
// own tool_use record and continues the chain only from the LAST result written (seen in local records, 2.1.33x: e.g.
// tool_use A → tool_use B; result A parent A, result B parent B, next record parent result B). Result A is then a leaf
// with no request after it on its chain, so D6 counts one write and no re-reads for it, although every later request
// sends it. The reader should give result A the same later requests as its batch sibling (expected [a2, a3]).
describe('#1123 review – parallel Bash calls', () => {
  const big = 'y'.repeat(28_000);
  const usage = { input_tokens: 10, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 20_000, output_tokens: 200 };
  const recs = [
    { type: 'user', uuid: 'u0', parentUuid: null, timestamp: ts(0), message: { role: 'user', content: 'x' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u0', timestamp: ts(1), requestId: 'R1', message: { content: [{ type: 'tool_use', id: 'tA', name: 'Bash', input: {} }], usage } },
    { type: 'assistant', uuid: 'a1b', parentUuid: 'a1', timestamp: ts(1), requestId: 'R1', message: { content: [{ type: 'tool_use', id: 'tB', name: 'Bash', input: {} }], usage } },
    { type: 'user', uuid: 'xA', parentUuid: 'a1', timestamp: ts(2), message: { content: [{ type: 'tool_result', tool_use_id: 'tA', content: big }] } },
    { type: 'user', uuid: 'xB', parentUuid: 'a1b', timestamp: ts(2), message: { content: [{ type: 'tool_result', tool_use_id: 'tB', content: 'ok' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'xB', timestamp: ts(3), requestId: 'R2', message: { content: [{ type: 'text', text: 'z' }], usage } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'a2', timestamp: ts(4), requestId: 'R3', message: { content: [{ type: 'text', text: 'z' }], usage } },
  ].map((r) => JSON.stringify({ ...r, isSidechain: false }));

  it('the result of the first of two parallel Bash calls is re-read by the requests after the batch', () => {
    const s = readSessionFields(recs.join('\n'));
    const a = s.toolResults.find((r) => r.chars === 28_000)!;
    expect(a.later!.map((i) => s.requests[i]!.t)).toEqual([3, 4].map((x) => Date.parse(ts(x))));
  });
});

describe('#1123 – properties', () => {
  it('ranking and shares are unchanged when the estimate inputs are unchanged (default-weight model, fallback-equal links)', () => {
    fc.assert(
      fc.property(fc.array(sessionArb, { minLength: 1, maxLength: 3 }), (sessions) => {
        const same = sessions.map((s) => ({
          ...s,
          requests: s.requests.map((r) => ({ ...r, model: 'claude-sonnet-4-6' })),
          toolResults: s.toolResults.map((r) => ({ ...r, later: s.requests.flatMap((q, i) => (q.t > r.t ? [i] : [])) })),
        }));
        const list = (x: SessionFields[]) =>
          buildHypotheses({ usage: null, config: CONFIG, transcripts: { sessions: x, stats: { sessions: x.length, records: 0, unknownRecords: 0, malformedLines: 0 } }, bin: 'b' }).hypotheses;
        expect(list(same)).toEqual(list(sessions));
      }),
      { numRuns: 300 },
    );
  });

  it('D6 shares stay in (0, 1] and exist on exactly the same sessions whatever the model', () => {
    fc.assert(
      fc.property(sessionArb, (s) => {
        const on = (model: string) => shareOf(checkD6([], [{ ...s, requests: s.requests.map((r) => ({ ...r, model })) }])[0]);
        const a = on('claude-opus-4-6'); // 0.1x, older tokenizer
        const b = on('claude-opus-5-5'); // 0.05x, 1.3x tokens: the share may move either way, but stays in (0, 1]
        for (const x of [a, b]) if (!Number.isNaN(x)) expect(x > 0 && x <= 1).toBe(true);
        expect(Number.isNaN(a)).toBe(Number.isNaN(b));
      }),
      { numRuns: 300 },
    );
  });
});
