import { writeFileSync } from 'node:fs';
// Regenerates the synthetic session fixtures (see README.md). Run from this folder: node generate.mjs
const T0 = Date.parse('2026-11-20T09:00:00Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const SECRET = 'sk-ant-api03-FIXTURESECRETDONOTLEAK0000';
const PROMPT = 'FIXTURE PROMPT TEXT: refactor the billing module for Zelda Quist';
const OUTPUT = 'FIXTURE TOOL OUTPUT /Users/zelda/work/repo/src/app.ts ' + SECRET;
function session(version, opts) {
  const L = [];
  const common = (extra) => ({ cwd: '/Users/zelda/work/repo', gitBranch: 'feature/acme-ticket-42', sessionId: 's-' + version, version, userType: 'external', ...extra });
  L.push({ type: 'user', ...common({ uuid: 'u0', timestamp: iso(0), isSidechain: false }), message: { role: 'user', content: PROMPT } });
  const mins = [0.2, 1, 2, 12, 13, 40, 41, 120];
  mins.forEach((m, i) => {
    const rid = `req_${version}_${i}`;
    const write = i === 0 || [3, 5, 7].includes(i) ? 30000 : 800;
    const usage = { input_tokens: 5, cache_creation_input_tokens: write, cache_read_input_tokens: i === 0 ? 0 : 30000, output_tokens: 400 };
    if (opts.split) usage.cache_creation = opts.split === '1h' ? { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: write };
    const blocks = [{ type: 'thinking', thinking: PROMPT }, { type: 'text', text: 'FIXTURE ASSISTANT TEXT ' + SECRET }, { type: 'tool_use', id: `tu_${i}`, name: i % 2 ? 'Bash' : 'Read', input: { command: 'npm test -- ' + SECRET } }];
    for (const [bi, b] of blocks.entries())
      L.push({ type: 'assistant', ...common({ uuid: `a${i}_${bi}`, timestamp: iso(m), isSidechain: false, requestId: rid, ...(opts.extraFields ? { attributionSkill: null, promptCacheRequested: '5m', effort: 'high' } : {}) }), message: { id: `msg_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [b], usage } });
    const big = i % 2 ? OUTPUT.repeat(220) : 'ok';
    const content = opts.arrayContent ? [{ type: 'text', text: big }] : big;
    L.push({ type: 'user', ...common({ uuid: `r${i}`, timestamp: iso(m + 0.1), isSidechain: false }), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content }] }, toolUseResult: { interrupted: false, isImage: false } });
  });
  for (const t of opts.unknownTypes) L.push({ type: t, ...common({ timestamp: iso(1) }), payload: PROMPT });
  return L.map((x) => JSON.stringify(x)).join('\n') + '\n{not json\n';
}
writeFileSync('v2.1.321.jsonl', session('2.1.321', { split: null, arrayContent: false, extraFields: false, unknownTypes: ['summary', 'file-history-snapshot'] }));
writeFileSync('v2.1.326.jsonl', session('2.1.326', { split: '5m', arrayContent: true, extraFields: false, unknownTypes: ['attachment', 'queue-operation', 'custom-title'] }));
writeFileSync('v2.1.330.jsonl', session('2.1.330', { split: '1h', arrayContent: true, extraFields: true, unknownTypes: ['api-request', 'data-flow-records', 'atis-latch', 'pr-link'] }));
