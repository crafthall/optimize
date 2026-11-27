// import-usage engine (R0-09): the /usage row parser on real-shaped rows (costs page, 2026-11-26), one seeded
// config repo per non-native check (D2, D3, D5, D6), the session-field reader on fixtures shaped after three Claude
// Code versions, and fast-check properties: the reader never returns message or tool text and survives any record;
// the hypothesis output never holds generated secrets, prompt text, absolute paths or identities.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildHypotheses,
  checkD2,
  checkD3,
  checkD5,
  checkD6,
  formatHypotheses,
  HYPOTHESIS_LABELS,
  MDE_AT_RUN_CAP,
  outputLeaks,
  costLabels,
  enforceClaims,
  ESTIMATED_NOT_MEASURABLE,
  ESTIMATED_NOT_MEASURED,
  MEASURING_QUALIFIER,
  ownWording,
  parseUsageText,
  readSessionFields,
  readTranscripts,
  scrubText,
  UsageParseError,
  type ConfigFile,
} from '../src/index';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'sessions');
const fixture = (v: string): string => readFileSync(join(FIXTURES, `v${v}.jsonl`), 'utf8');
const VERSIONS = ['2.1.321', '2.1.326', '2.1.330'];
const SENTINELS = ['sk-ant-api03-FIXTURESECRETDONOTLEAK0000', 'FIXTURE PROMPT TEXT', 'FIXTURE TOOL OUTPUT', 'FIXTURE ASSISTANT TEXT', '/Users/zelda', 'Zelda Quist', 'acme-ticket-42', 'npm test --'];

const DOCS_ROWS = ['25%  Trim ~/code/api/CLAUDE.md · 49k tokens per request', '40%  Switch from max to high effort · /effort high', '30%  Compact before you step away · run /compact'].join('\n');

describe('parseUsageText – /usage row shapes', () => {
  it('reads the three row shapes of the costs page', () => {
    const u = parseUsageText(DOCS_ROWS);
    expect(u.rows).toEqual([
      { line: 1, share: 0.25, action: 'Trim ~/code/api/CLAUDE.md', detail: '49k tokens per request', shape: 'other', tokensPerRequest: 49_000 },
      { line: 2, share: 0.4, action: 'Switch from max to high effort', detail: '/effort high', shape: 'effort', tokensPerRequest: null },
      { line: 3, share: 0.3, action: 'Compact before you step away', detail: 'run /compact', shape: 'run', tokensPerRequest: null },
    ]);
  });

  it('strips terminal box borders, bullets and tabs (terminal copy, VS Code dialog copy)', () => {
    const u = parseUsageText(['│ 25%  Trim CLAUDE.md · 49k tokens per request   │', '• 12% Clear between unrelated tasks · run /clear', '18%\tMove workflows to skills\t1.2M tokens per request'].join('\n'));
    expect(u.rows.map((r) => [r.share, r.action, r.shape, r.tokensPerRequest])).toEqual([
      [0.25, 'Trim CLAUDE.md', 'other', 49_000],
      [0.12, 'Clear between unrelated tasks', 'run', null],
      [0.18, 'Move workflows to skills', 'other', 1_200_000],
    ]);
  });

  it('reads the Session block and the Prompt cache (main) line, ignoring bars and attribution', () => {
    const text = [
      'Session',
      'Estimated cost:        $0.55',
      'Usage by model:',
      '   claude-sonnet-4-6:  1.2k input, 5.3k output, 940.0k cache read, 50.0k cache write ($0.55)',
      'Prompt cache (main):   14 requests · 91% of input tokens from cache · 2 misses (last 6m 10s ago, 310.2k tokens re-cached, likely cause: tool definitions changed) · warm (1h TTL, last activity 40s ago)',
      'Current week (all models)  ██████░░░░ 61%',
      '',
      '22%  Trim CLAUDE.md · 31k tokens per request',
      'f to fix 1 of 1',
    ].join('\n');
    const u = parseUsageText(text);
    expect(u.promptCache).toEqual({ line: 5, requests: 14, hitShare: 0.91, misses: 2, likelyCause: 'tool definitions changed', ttl: '1h' });
    expect(u.rows).toHaveLength(1);
    expect(u.ignored).toBe(1);
  });

  it('empty input is no rows (config checks only)', () => {
    expect(parseUsageText('  \n\n')).toEqual({ rows: [], promptCache: null, recognized: 0, ignored: 0 });
  });

  it.each([
    ['a share above 100%', '150%  Trim CLAUDE.md · 49k tokens per request', 1],
    ['a row with no change text', '25%  · 12', 1],
    ['text with no /usage line', 'hello\nthis is not usage output', null],
  ])('malformed input: %s → UsageParseError', (_n, text, line) => {
    expect(() => parseUsageText(text)).toThrow(UsageParseError);
    try {
      parseUsageText(text);
    } catch (e) {
      expect((e as UsageParseError).line).toBe(line);
    }
  });
});

describe('readSessionFields – fixtures of three Claude Code versions', () => {
  it.each(VERSIONS)('%s: one request per requestId, gaps, Bash results, unknown records skipped', (v) => {
    const stats = { sessions: 0, records: 0, unknownRecords: 0, malformedLines: 0 };
    const s = readSessionFields(fixture(v), stats);
    expect(s.requests).toHaveLength(8);
    expect(s.requests.every((r) => !r.sidechain && r.input === 5 && r.output === 400)).toBe(true);
    expect(s.toolResults.filter((r) => r.bash && r.chars > 20_000)).toHaveLength(4);
    expect(s.toolResults.filter((r) => !r.bash)).toHaveLength(4);
    expect(stats.malformedLines).toBe(1);
    expect(stats.unknownRecords).toBeGreaterThanOrEqual(2);
    expect(s.ttlSplit).toBe(v !== '2.1.321');
    const json = JSON.stringify(s);
    for (const x of SENTINELS) expect(json).not.toContain(x);
  });

  it('5m-TTL sessions with 10- and 27-minute gaps → D2 suggests 1h; 1h-TTL sessions with no mid-gap reads → 5m', () => {
    const on5m = checkD2([readSessionFields(fixture('2.1.326'))]);
    expect(on5m.map((d) => d.id)).toEqual(['D2-ttl-1h']);
    // The fixture's requests are claude-opus-5-5: cache reads at 0.05x (0.1x before, share 21,600 ÷ 191,040).
    // W = 4×30000 + 4×800 = 123200; R = 60000 (writes after the two mid gaps); Δ = (2 − 0.05)R − 0.75W = 24600 units.
    // Total token cost with output at 5x (QA): 8 requests × 400 output tokens.
    const units = 8 * 5 + 123_200 * 1.25 + 7 * 30_000 * 0.05 + 8 * 400 * 5;
    expect(on5m[0]!.effect).toEqual({ kind: 'estimate', share: 24_600 / units });
    expect(on5m[0]!.forceNotMeasurable).toMatch(/no idle gaps/);
    const legacy = checkD2([readSessionFields(fixture('2.1.321'))]);
    expect(legacy[0]!.id).toBe('D2-ttl-1h');
    expect(checkD2([readSessionFields(fixture('2.1.330'))]).map((d) => d.id)).toEqual(['D2-ttl-5m']);
  });

  it('no idle gaps between 5 and 60 minutes → no D2 hypothesis', () => {
    const s = readSessionFields(fixture('2.1.326'));
    const tight = { ...s, requests: s.requests.map((r, i) => ({ ...r, t: i * 60_000 })) };
    expect(checkD2([tight])).toEqual([]);
  });
});

const CLAUDE_MD = ['# Project', '', 'Always run the full test suite before you open a pull request in this repository.', 'Keep answers short.', '```', 'Always run the full test suite before you open a pull request in this repository.', '```'].join('\n');
const RULE = ['- Always run the full test suite before you open a pull request in this repository!', 'Never run the full test suite before small doc changes are pushed.'].join('\n');

describe('non-native checks on seeded config repos', () => {
  it('D3: opusplan, disabled caching and a skill that switches model; context: fork and inherit do not count', () => {
    const config: ConfigFile[] = [
      { path: '.claude/settings.json', text: '{\n  "model": "opusplan",\n  "env": {\n    "DISABLE_PROMPT_CACHING": "1",\n    "OTHER": "1"\n  }\n}' },
      { path: '.claude/skills/review/SKILL.md', text: '---\nname: review\nmodel: claude-haiku-5-5\n---\nbody' },
      { path: '.claude/skills/forked/SKILL.md', text: '---\nname: forked\nmodel: haiku\ncontext: fork\n---\n' },
      { path: '.claude/commands/plain.md', text: '---\nmodel: inherit\n---\n' },
    ];
    const d = checkD3(config, null);
    expect(d.map((x) => x.id)).toEqual(['D3-opusplan', 'D3-disable-prompt-caching', 'D3-skill-model']);
    expect(d[0]!.evidence[0]).toMatchObject({ file: '.claude/settings.json', line: 2 });
    expect(d[1]!.evidence[0]).toMatchObject({ line: 4 });
    expect(d[2]!.evidence).toEqual([{ note: 'sets model claude-haiku-5-5', file: '.claude/skills/review/SKILL.md', line: 3 }]);
  });

  it('D3: the likely cause of the pasted cache line becomes a hypothesis', () => {
    const usage = parseUsageText('Prompt cache (main):   9 requests · 80% of input tokens from cache · 3 misses (likely cause: tool definitions changed) · cold');
    expect(checkD3([], usage)[0]!.change).toContain('likely cause: tool definitions changed');
  });

  it('D5: near-exact duplicates (case, punctuation, list markers) outside code fences, and always/never contradictions', () => {
    const d = checkD5(
      [
        { path: 'CLAUDE.md', text: CLAUDE_MD },
        { path: '.claude/rules/tests.md', text: RULE },
      ],
      null,
    );
    expect(d.map((x) => x.id)).toEqual(['D5-duplicates', 'D5-contradictions']);
    expect(d[0]!.evidence[0]!.note).toBe('same line in 2 places: CLAUDE.md:3, .claude/rules/tests.md:1');
    expect(d[0]!.effect).toEqual({ kind: 'unknown' });
    expect(d[0]!.note).toMatch(/redundant tokens in always-loaded files; pass --read-transcripts/);
    expect(d[1]!.evidence[0]!.note).toContain('.claude/rules/tests.md:2');
  });

  it('D5: with session fields the duplicate gets an estimated share, labelled not measurable when below the MDE', () => {
    const list = buildHypotheses({
      usage: null,
      config: [
        { path: 'CLAUDE.md', text: CLAUDE_MD },
        { path: '.claude/rules/tests.md', text: RULE },
      ],
      transcripts: readTranscripts([fixture('2.1.326')]),
      bin: 'crafthall-optimize',
    });
    const dup = list.hypotheses.find((h) => h.id === 'D5-duplicates')!;
    expect(dup.effect.kind).toBe('estimate');
    expect(dup.label).toBe(HYPOTHESIS_LABELS.notMeasurable);
  });

  it('D6: no Bash PreToolUse hook + large Bash results → sized hypothesis; a Bash hook → none; config only → unsized', () => {
    const sessions = [readSessionFields(fixture('2.1.330'))];
    const pkg = { path: 'package.json', text: '{\n  "scripts": {\n    "test": "vitest"\n  }\n}' };
    const sized = checkD6([pkg], sessions);
    expect(sized[0]!.effect.kind).toBe('estimate');
    expect(sized[0]!.evidence[0]!.note).toBe('4 Bash results over 20000 characters, no PreToolUse filter on Bash');
    const hook = { path: '.claude/settings.json', text: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{ type: 'command', command: 'x' }] }] } }) };
    expect(checkD6([pkg, hook], sessions)).toEqual([]);
    expect(checkD6([pkg], null)[0]).toMatchObject({ effect: { kind: 'unknown' }, evidence: [{ file: 'package.json', line: 3 }] });
    expect(checkD6([], null)).toEqual([]);
  });
});

describe('buildHypotheses – ranking, labels, output', () => {
  const list = buildHypotheses({
    usage: parseUsageText(DOCS_ROWS + '\n8%  Remove unused MCP servers · 3k tokens per request'),
    config: [
      { path: 'CLAUDE.md', text: CLAUDE_MD },
      { path: '.claude/rules/tests.md', text: RULE },
    ],
    transcripts: null,
    repoRoot: '/home/zq/code/api',
    home: '/home/zq',
    identities: [],
    bin: 'crafthall-optimize',
  });

  it('ranks by effect (native share as an upper bound), unknown effects last', () => {
    expect(list.hypotheses.map((h) => h.id)).toEqual(['native-2', 'native-3', 'native-1', 'native-4', 'D5-contradictions', 'D5-duplicates']);
    expect(list.hypotheses.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a pasted ~/ path inside the repo becomes repo-relative', () => {
    expect(list.hypotheses[2]!.change).toBe('Trim CLAUDE.md · 49k tokens per request');
  });

  it('labels: a row below the MDE is not measurable; a run-row habit is not measurable; others not measured', () => {
    const byId = Object.fromEntries(list.hypotheses.map((h) => [h.id, h.label]));
    expect(MDE_AT_RUN_CAP).toBeGreaterThan(0.15);
    expect(MDE_AT_RUN_CAP).toBeLessThan(0.25);
    expect(byId).toMatchObject({ 'native-1': 'estimated, not measured', 'native-2': 'estimated, not measured', 'native-3': 'estimated, not measurable', 'native-4': 'estimated, not measurable' });
  });

  it('first line is the verdict-style summary; no line says "saved" or claims a measured result', () => {
    const lines = formatHypotheses(list);
    expect(lines[0]).toBe('6 hypotheses to test with compare (estimated, not measured): 4 from native /usage rows, 2 from non-native checks; 2 estimated, not measurable');
    for (const l of lines) {
      expect(l).not.toMatch(/\bsaved\b|measured saving|likely saving|proven/i);
    }
    expect(lines.join('\n')).toContain('try: crafthall-optimize compare --change optimize-native-2.patch --plan-only');
    expect(outputLeaks(list)).toEqual([]);
  });

  it('labels come from labels.ts; the own wording passes enforceClaims for every billing mode, with qualifier 6', () => {
    expect(HYPOTHESIS_LABELS).toEqual({ notMeasured: ESTIMATED_NOT_MEASURED, notMeasurable: ESTIMATED_NOT_MEASURABLE });
    const lines = formatHypotheses(ownWording(list));
    expect(lines).toContain(MEASURING_QUALIFIER);
    for (const billing of ['api', 'subscription', 'credits', null] as const) expect(() => enforceClaims(lines, { labels: costLabels(undefined, billing), report: false })).not.toThrow();
  });
});

describe('scrubText', () => {
  it('keeps slash commands, makes repo paths relative, hides other paths, secrets, e-mails and identities', () => {
    const s = scrubText('Trim /Users/zq/repo/docs/A.md and ~/elsewhere/B.md and ~/x/CLAUDE.md · /effort high · sk-ant-abcdefghijklmnop · zq@example.org · Zelda', {
      repoRoot: '/Users/zq/repo',
      home: '/Users/zq',
      identities: ['Zelda'],
    });
    expect(s).toBe('Trim docs/A.md and <outside repo> and <outside repo>/CLAUDE.md · /effort high · [redacted] · [redacted] · [redacted]');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Properties

const token = fc.stringMatching(/^[A-Za-z0-9]{12,20}$/);
const secretArb = token.map((t) => `sk-ant-api03-${t}`);
const promptArb = token.map((t) => `PROMPT${t} please refactor the module and keep tests green`);
const identityArb = fc.stringMatching(/^[a-z]{6,10}$/).map((s) => `zq${s}`);

describe('properties', () => {
  it('the session reader returns no message or tool text for any record and never throws', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.oneof(fc.constant('assistant'), fc.constant('user'), fc.string()),
            requestId: fc.option(fc.string()),
            timestamp: fc.oneof(fc.date({ noInvalidDate: true }).map((d) => d.toISOString()), fc.anything()),
            message: fc.anything(),
            text: promptArb,
            secret: secretArb,
          }),
          { maxLength: 12 },
        ),
        fc.array(fc.anything(), { maxLength: 4 }),
        (recs, junk) => {
          const lines = recs.map((r) =>
            JSON.stringify({
              ...r,
              message: {
                id: 'm',
                content: [
                  { type: 'text', text: r.text },
                  { type: 'tool_use', id: 't1', name: 'Bash', input: { command: r.secret } },
                  { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `${r.secret} ${r.text}` }] },
                ],
                usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
                junk: r.message,
              },
            }),
          );
          const text = [...lines, ...junk.map((j) => String(JSON.stringify(j) ?? j)), '{broken'].join('\n');
          const out = JSON.stringify(readTranscripts([text]));
          for (const r of recs) {
            expect(out).not.toContain(r.text);
            expect(out).not.toContain(r.secret);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('the hypothesis output never holds generated secrets, prompt text, absolute paths or identities', () => {
    fc.assert(
      fc.property(secretArb, promptArb, identityArb, token, (secret, prompt, identity, dir) => {
        const abs = `/Users/${identity}/${dir}/notes.md`;
        const line = `Always use ${secret} and ${prompt} from ${abs} for ${identity} in every single request.`;
        const config: ConfigFile[] = [
          { path: 'CLAUDE.md', text: `${line}\n${prompt}\n` },
          { path: '.claude/rules/a.md', text: `${line}\nNever use ${secret} and ${prompt} from ${abs} anywhere.\n` },
          { path: `.claude/agents/${identity}.md`, text: `---\nmodel: ${secret}\n---\n${line}\n` },
          { path: `.claude/skills/${identity}/SKILL.md`, text: `---\nmodel: ${secret}\n---\n${prompt}\n` },
          { path: '.claude/settings.json', text: JSON.stringify({ model: 'opusplan', env: { API_KEY: secret, DISABLE_PROMPT_CACHING: '1' } }) },
          { path: 'package.json', text: JSON.stringify({ scripts: { test: `${prompt} ${secret}` } }) },
        ];
        const usage = parseUsageText(`25%  Trim ${abs} for ${identity} · 49k tokens per request\n30%  Use key ${secret} · run /compact`);
        const session = [
          JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: '2026-11-20T09:00:00Z', message: { content: [{ type: 'text', text: prompt }], usage: { input_tokens: 1, cache_creation_input_tokens: 9000 } } }),
          JSON.stringify({ type: 'user', timestamp: '2026-11-20T09:00:10Z', cwd: abs, message: { content: [{ type: 'tool_result', content: `${secret} ${prompt} ${abs}`.repeat(600) }] } }),
          JSON.stringify({ type: 'assistant', requestId: 'r2', timestamp: '2026-11-20T09:20:00Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: secret } }], usage: { cache_creation_input_tokens: 9000 } } }),
        ].join('\n');
        const list = buildHypotheses({ usage, config, transcripts: readTranscripts([session]), identities: [identity], repoRoot: '/work/repo', home: `/Users/${identity}`, bin: 'crafthall-optimize' });
        const out = `${formatHypotheses(list).join('\n')}\n${JSON.stringify(list)}`;
        for (const x of [secret, prompt, abs, `/Users/${identity}`, identity, dir]) expect(out).not.toContain(x);
        expect(outputLeaks(list, [identity])).toEqual([]);
        expect(list.hypotheses.length).toBeGreaterThan(2);
      }),
      { numRuns: 100 },
    );
  });
});
