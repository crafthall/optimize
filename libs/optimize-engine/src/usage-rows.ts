// Parser of the text a user pastes from Claude Code's own `/usage` screen (R0-09; feature import-usage).
// Claude Code has no documented machine-readable export of `/usage`, so the user copies the lines; the bars are never
// scraped. Shapes recognised (costs page, https://code.claude.com/docs/en/costs, read 2026-11-26):
//   recommendation rows   `25%  Trim ~/code/api/CLAUDE.md · 49k tokens per request`
//                         `40%  Switch from max to high effort · /effort high`
//                         `30%  Compact before you step away · run /compact`
//   the cache line        `Prompt cache (main):   14 requests · 91% of input tokens from cache · 2 misses (…) · warm (1h TTL, …)`
//   other Session lines   `Estimated cost: …`, `Usage by model:`, `   claude-…: 1.2k input, …`, the `f to fix 2 of 3` footer
// Terminal and dialog copies add box-drawing borders, bullets or tabs; they are stripped. Lines of no known shape are
// ignored (counted). Pure: no I/O.

export interface UsageRow {
  /** 1-based line number in the pasted text. */
  line: number;
  /** Share of recent usage the row applies to, 0..1 – NOT the effect of the change (costs page). */
  share: number;
  /** The suggested change, e.g. "Trim ~/code/api/CLAUDE.md" (raw; the caller scrubs paths before output). */
  action: string;
  /** Text after the ` · ` separator, e.g. "49k tokens per request" or "/effort high"; null when absent. */
  detail: string | null;
  /** What `f` does with the row (costs page table): runs an `/effort` command, a command the user runs, or other. */
  shape: 'effort' | 'run' | 'other';
  /** Tokens per request named by the row ("49k tokens per request" → 49000); null when not named. */
  tokensPerRequest: number | null;
}

export interface PromptCacheLine {
  line: number;
  requests: number | null;
  /** Share of input tokens served from cache, 0..1. */
  hitShare: number | null;
  misses: number | null;
  /** "likely cause: …" text (v2.1.260+), reduced to lower-case words; null when absent. */
  likelyCause: string | null;
  /** TTL in effect when the user ran `/usage`. */
  ttl: '5m' | '1h' | null;
}

export interface ParsedUsage {
  rows: UsageRow[];
  promptCache: PromptCacheLine | null;
  /** Lines of a known `/usage` shape (rows, cache line, other Session lines). */
  recognized: number;
  /** Non-empty lines of no known shape (attribution rows, bars, headings…); ignored. */
  ignored: number;
}

/** Pasted text that has a row-shaped line we cannot read, or no `/usage` line at all (CLI exit code 2). */
export class UsageParseError extends Error {
  constructor(
    message: string,
    readonly line: number | null,
  ) {
    super(message);
    this.name = 'UsageParseError';
  }
}

/** Borders, bullets and quote marks that terminal or dialog copies put around a line. */
const FRAME = /^[\s│┃|•·*>\-–]+|[\s│┃|]+$/g;
const SEPARATOR = /\s+·\s+|\s*·\s*|\s+\|\s+|\t+/;
const ROW = /^(\d{1,4}(?:\.\d+)?)\s*%\s+(.+)$/;
const SESSION_LINE = /^(?:estimated cost|total duration|total code changes|usage by model|claude-[a-z0-9.-]+\s*:|f to fix|session\b|recommendations\b|showing last-known usage)/i;

/** "49k" → 49000, "1.2M" → 1200000. */
export function parseTokenCount(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1e3 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseRow(text: string, line: number): UsageRow | 'not-a-row' {
  const m = ROW.exec(text);
  if (!m) return 'not-a-row';
  const pct = Number(m[1]);
  if (!(pct >= 0 && pct <= 100)) throw new UsageParseError(`line ${line}: a /usage row share must be between 0% and 100%, got ${m[1]}%`, line);
  const parts = m[2]!.split(SEPARATOR).map((s) => s.trim()).filter(Boolean);
  const action = parts[0] ?? '';
  if (!/[A-Za-z]{2,}/.test(action)) throw new UsageParseError(`line ${line}: a /usage row needs the suggested change after the share`, line);
  const detail = parts.length > 1 ? parts.slice(1).join(' · ') : null;
  const shape = detail && /^\/effort\b/.test(detail) ? 'effort' : detail && /^run\s+\//.test(detail) ? 'run' : 'other';
  const tokens = detail ? /(\d+(?:\.\d+)?\s*[kKmM]?)\s+tokens per request/.exec(detail) : null;
  return { line, share: pct / 100, action, detail, shape, tokensPerRequest: tokens ? parseTokenCount(tokens[1]!) : null };
}

function parsePromptCache(text: string, line: number): PromptCacheLine | null {
  if (!/^prompt cache \(main\)\s*:/i.test(text)) return null;
  const num = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const hit = num(/(\d{1,3}(?:\.\d+)?)%\s+of input tokens from cache/i);
  const cause = /likely cause:\s*([A-Za-z][A-Za-z ,-]{0,80})/i.exec(text);
  const ttl = /\b(5m|1h)\s+TTL\b/i.exec(text);
  return {
    line,
    requests: num(/(\d+)\s+requests?\b/i),
    hitShare: hit === null ? null : Math.min(1, hit / 100),
    misses: num(/(\d+)\s+miss(?:es)?\b/i),
    likelyCause: cause ? cause[1]!.toLowerCase().replace(/[^a-z ,-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
    ttl: ttl ? (ttl[1]!.toLowerCase() as '5m' | '1h') : null,
  };
}

/**
 * Reads pasted `/usage` text. Empty text gives an empty result (the caller runs the config checks only). Non-empty
 * text with no line of a known shape, or a row-shaped line that cannot be read, throws UsageParseError.
 */
export function parseUsageText(text: string): ParsedUsage {
  const out: ParsedUsage = { rows: [], promptCache: null, recognized: 0, ignored: 0 };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, i) => {
    const line = i + 1;
    const t = raw.replace(FRAME, '').trim();
    if (!t) return;
    const cache = parsePromptCache(t, line);
    if (cache) {
      out.promptCache = cache;
      out.recognized++;
      return;
    }
    const row = parseRow(t, line);
    if (row !== 'not-a-row') {
      out.rows.push(row);
      out.recognized++;
      return;
    }
    if (SESSION_LINE.test(t)) out.recognized++;
    else out.ignored++;
  });
  if (out.recognized === 0 && out.ignored > 0)
    throw new UsageParseError(
      'no /usage line found in the pasted text: paste the recommendation rows (for example "25%  Trim CLAUDE.md · 49k tokens per request") or the Session block',
      null,
    );
  return out;
}
