// Usage-field reader of Claude Code's local session records (`~/.claude/projects/<project>/<session>.jsonl`), used only
// when the user passes `import-usage --read-transcripts <dir>` (legal note §1 rule 4). It keeps FIELDS, never text
// (rule 1): timestamps, token counts, the cache TTL split, `isSidechain`, and the size in characters of a tool result
// with a Bash/other flag. Message text, tool input and tool output are never copied into the result; a tool result's
// size is measured and the text is dropped at once.
// The record format is not a documented contract (23 record types seen on 2026-11-26, versions 2.1.321–2.1.330):
// unknown record types, malformed lines and missing fields are counted and skipped, never fatal. An assistant message
// is written once per content block with the same `requestId`, so usage is counted once per request.
// adds two fields, still no text: the request's `message.model` id (for the per-model cache-read and tokenizer
// weights, model-weights.ts) and, for a Bash result, the requests on its own chain after it (`later`), found through the
// `uuid` / `parentUuid` links (results of parallel calls of one request share their later requests). A compaction boundary (`parentUuid: null`, `logicalParentUuid` set) is followed like a
// parent link: compaction effects are ignored on purpose (the summary replaces the result, so this overstates D6).

export interface RequestFields {
  /** Epoch milliseconds; NaN when the record has no readable timestamp. */
  t: number;
  sidechain: boolean;
  input: number;
  /** Cache writes at the 5-minute TTL (all writes when the record has no TTL split). */
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  /** `message.model` of the request (an id such as `claude-opus-5-5`), null when absent or not an id. */
  model?: string | null;
}

export interface ToolResultFields {
  t: number;
  /** Only whether the tool was Bash (what a `PreToolUse` filter on `Bash` can trim); never the tool input. */
  bash: boolean;
  /** Size of the result content in characters (text dropped). */
  chars: number;
  /** `isSidechain` of the record that carries the result. */
  sidechain?: boolean;
  /**
   * Indexes into `requests` of the requests on this result's own chain after it (descendants through `parentUuid`), in
   * time order. Undefined when the file has no chain links; then D6 falls back to later requests of the same sidechain flag.
   */
  later?: number[];
}

export interface SessionFields {
  requests: RequestFields[];
  toolResults: ToolResultFields[];
  /** True when at least one request had the 5m/1h split (`usage.cache_creation`). */
  ttlSplit: boolean;
}

export interface TranscriptStats {
  sessions: number;
  records: number;
  unknownRecords: number;
  malformedLines: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const time = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);

/** Characters of a tool_result `content` (a string or an array of blocks with `text`); text is not kept. */
function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    const text = obj(b)?.['text'];
    if (typeof text === 'string') n += text.length;
  }
  return n;
}

const KNOWN_TYPES = new Set(['assistant', 'user']);
/** Model ids are kept only when they look like an id (never free text). */
const MODEL_ID = /^[A-Za-z0-9<][A-Za-z0-9._:@/\-[\]<>]{0,99}$/;

/** Reads one session file (JSON Lines). Pure; never throws. */
export function readSessionFields(jsonl: string, stats?: TranscriptStats): SessionFields {
  const out: SessionFields = { requests: [], toolResults: [], ttlSplit: false };
  const seen = new Set<string>();
  const bashIds = new Set<string>();
  const pendingResults: { t: number; id: string; chars: number; sidechain: boolean; uuid: string | null }[] = [];
  const children = new Map<string, string[]>();
  const requestKeyOf = new Map<string, string>(); // assistant record uuid → request key
  const batchOf = new Map<string, string>(); // tool_use id → key of the assistant request that made the call
  const requestKeys: string[] = []; // parallel to out.requests before sorting
  let linked = false;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown> | null;
    try {
      rec = obj(JSON.parse(line));
    } catch {
      rec = null;
    }
    if (!rec) {
      if (stats) stats.malformedLines++;
      continue;
    }
    if (stats) stats.records++;
    const uuid = typeof rec['uuid'] === 'string' ? rec['uuid'] : null;
    if ('parentUuid' in rec) linked = true;
    const parent = typeof rec['parentUuid'] === 'string' ? rec['parentUuid'] : typeof rec['logicalParentUuid'] === 'string' ? rec['logicalParentUuid'] : null;
    if (uuid && parent) children.set(parent, [...(children.get(parent) ?? []), uuid]);
    const type = rec['type'];
    if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) {
      if (stats) stats.unknownRecords++;
      continue;
    }
    const message = obj(rec['message']);
    const content = message?.['content'];
    if (type === 'assistant') {
      const batch = typeof rec['requestId'] === 'string' ? rec['requestId'] : typeof message?.['id'] === 'string' ? (message['id'] as string) : uuid;
      if (Array.isArray(content))
        for (const b of content) {
          const block = obj(b);
          if (block?.['type'] !== 'tool_use' || typeof block['id'] !== 'string') continue;
          if (block['name'] === 'Bash') bashIds.add(block['id']);
          if (batch) batchOf.set(block['id'], batch);
        }
      const usage = obj(message?.['usage']);
      if (!usage) continue;
      const key = typeof rec['requestId'] === 'string' ? rec['requestId'] : typeof message?.['id'] === 'string' ? (message['id'] as string) : null;
      const reqKey = key ?? `record:${uuid ?? out.requests.length}`;
      if (uuid) requestKeyOf.set(uuid, reqKey);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      requestKeys.push(reqKey);
      const model = message?.['model'];
      const split = obj(usage['cache_creation']);
      const written = num(usage['cache_creation_input_tokens']);
      const w1h = split ? num(split['ephemeral_1h_input_tokens']) : 0;
      const w5m = split ? num(split['ephemeral_5m_input_tokens']) : written;
      if (split) out.ttlSplit = true;
      out.requests.push({
        t: time(rec['timestamp']),
        sidechain: rec['isSidechain'] === true,
        input: num(usage['input_tokens']),
        write5m: split && w5m + w1h === 0 ? written : w5m,
        write1h: w1h,
        read: num(usage['cache_read_input_tokens']),
        output: num(usage['output_tokens']),
        model: typeof model === 'string' && MODEL_ID.test(model) ? model : null,
      });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        const block = obj(b);
        if (block?.['type'] !== 'tool_result') continue;
        pendingResults.push({
          t: time(rec['timestamp']),
          id: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '',
          chars: contentChars(block['content']),
          sidechain: rec['isSidechain'] === true,
          uuid,
        });
      }
    }
  }
  // Sort requests by time and keep the key of each, so chain links can point at the sorted index.
  const order = out.requests.map((_, i) => i).sort((a, b) => (out.requests[a]!.t || 0) - (out.requests[b]!.t || 0) || a - b);
  out.requests = order.map((i) => out.requests[i]!);
  const indexOfKey = new Map<string, number>();
  order.forEach((orig, sorted) => indexOfKey.set(requestKeys[orig]!, sorted));
  // Parallel tool calls (QA review): each tool_result's parent is its own tool_use record and only the last
  // result written continues the chain, so a sibling result is a leaf. All results of the calls of one assistant request
  // (same requestId) therefore share the union of their later requests.
  const batchResults = new Map<string, string[]>(); // request key → uuids of the results of its tool calls
  for (const r of pendingResults) {
    const batch = batchOf.get(r.id);
    if (batch && r.uuid) batchResults.set(batch, [...(batchResults.get(batch) ?? []), r.uuid]);
  }
  for (const r of pendingResults) {
    const bash = bashIds.has(r.id);
    const field: ToolResultFields = { t: r.t, bash, chars: r.chars, sidechain: r.sidechain };
    // Chains only for Bash results (the only ones D6 sizes) and only when the file carries parent links.
    if (bash && linked && r.uuid) {
      const batch = batchOf.get(r.id);
      const roots = batch ? (batchResults.get(batch) ?? [r.uuid]) : [r.uuid];
      field.later = [...new Set(roots.flatMap((u) => laterOnChain(u, children, requestKeyOf, indexOfKey)))].sort((a, b) => a - b);
    }
    out.toolResults.push(field);
  }
  return out;
}

/** Sorted request indexes of the assistant records that descend from `root` (its own chain after it). */
function laterOnChain(root: string, children: Map<string, string[]>, requestKeyOf: Map<string, string>, indexOfKey: Map<string, number>): number[] {
  const found = new Set<number>();
  const visited = new Set<string>([root]);
  const queue = [...(children.get(root) ?? [])];
  while (queue.length) {
    const u = queue.pop()!;
    if (visited.has(u)) continue;
    visited.add(u);
    const key = requestKeyOf.get(u);
    const i = key === undefined ? undefined : indexOfKey.get(key);
    if (i !== undefined) found.add(i);
    for (const c of children.get(u) ?? []) queue.push(c);
  }
  return [...found].sort((a, b) => a - b);
}

export const emptyTranscriptStats = (): TranscriptStats => ({ sessions: 0, records: 0, unknownRecords: 0, malformedLines: 0 });

/** Reads every session file given as text. Pure; never throws. */
export function readTranscripts(files: readonly string[]): { sessions: SessionFields[]; stats: TranscriptStats } {
  const stats = emptyTranscriptStats();
  const sessions = files.map((f) => readSessionFields(f, stats));
  stats.sessions = sessions.length;
  return { sessions, stats };
}
