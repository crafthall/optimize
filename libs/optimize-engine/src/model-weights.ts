// Per-model weights of the import-usage estimates (QA review, stats-review-1031.md §10 items 1, 7, 9).
// Sources (accessed 2026-11-26): platform.claude.com/docs/en/about-claude/pricing and
// platform.claude.com/docs/en/build-with-claude/prompt-caching ("Economics"): cache reads cost 0.1x the base input price
// on most models, 0.05x on Claude Opus 5.5 ($0.20 on $4) and Claude Sonnet 5.5 ($0.10 on $2), 0.025x on Claude Fable /
// Mythos 5.2 ($0.20 on $8) and 5.1 ($0.25 on $10); Claude Fable / Mythos 5 read at $1 on $10 = 0.1x. Cache writes (5m
// 1.25x, 1h 2x) and output (5x input) are the same on every listed model, so only the read weight depends on the model.
// Tokenizer: the models page says the tokenizer introduced with Claude Opus 4.7 (used by Opus 4.7+, Sonnet 5+, Haiku 5.5
// and every Fable / Mythos model) produces about 1.0x–1.35x as many tokens for the same text as the older one ("about
// 30% more" for Sonnet 5 vs Sonnet 4.6 and for Haiku 5.5). The engine's chars ÷ 4 is a rule of thumb for the older
// tokenizer, so sizes from characters are multiplied by NEW_TOKENIZER_FACTOR on those models. 1.3 is an ESTIMATE (the
// documented ~30%, inside the 1.0–1.35 range), not a measured ratio for Claude Code tool output.
// Unknown model (no `message.model`, a synthetic record, a provider id we cannot parse): DEFAULT_MODEL_WEIGHTS, which
// are the weights the engine used before per-model weights existed (read 0.1x, chars ÷ 4 with no factor), so a session
// with no model information ranks exactly as before.

/** Characters per token of the older tokenizer (rule of thumb; an estimate). */
export const CHARS_PER_TOKEN = 4;
/** Tokens of the Opus 4.7+ tokenizer per token of the older one, for the same text. ESTIMATE: the documented ~30%. */
export const NEW_TOKENIZER_FACTOR = 1.3;

export interface ModelWeights {
  /** Cache-read weight relative to uncached input of the same model. */
  read: number;
  /** Multiplier on chars ÷ CHARS_PER_TOKEN for this model's tokenizer. */
  tokenizer: number;
}

/** Weights for a model the engine cannot identify: the pre- weights (documented default). */
export const DEFAULT_MODEL_WEIGHTS: ModelWeights = { read: 0.1, tokenizer: 1 };

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';

/** Family and version of a model id (`claude-opus-5-5`, `claude-sonnet-4-20250514`, `us.anthropic.claude-fable-5-2-v1`). */
export function parseModelId(model: string | null | undefined): { family: ModelFamily; major: number; minor: number } | null {
  if (typeof model !== 'string') return null;
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/.exec(model.toLowerCase());
  if (m) return { family: m[1] as ModelFamily, major: Number(m[2]), minor: m[3] === undefined ? 0 : Number(m[3]) };
  // Claude 3 naming (`claude-3-5-sonnet-20241022`): older tokenizer, read 0.1x.
  const old = /claude-(\d)-(?:(\d)-)?(opus|sonnet|haiku)(?![a-z])/.exec(model.toLowerCase());
  if (old) return { family: old[3] as ModelFamily, major: Number(old[1]), minor: old[2] === undefined ? 0 : Number(old[2]) };
  return null;
}

const atLeast = (v: { major: number; minor: number }, major: number, minor: number): boolean => v.major > major || (v.major === major && v.minor >= minor);

/** Cost and tokenizer weights of the model that served a request; DEFAULT_MODEL_WEIGHTS when it cannot be identified. */
export function modelWeights(model: string | null | undefined): ModelWeights {
  const v = parseModelId(model);
  // Claude Mythos Preview (`claude-mythos-preview`) has no version number but uses the newer tokenizer (pricing page,
  // accessed 2026-11-26); its cache reads are not listed apart, so the standard 0.1x applies (QA review).
  if (!v) return typeof model === 'string' && /claude-mythos-preview/i.test(model) ? { read: 0.1, tokenizer: NEW_TOKENIZER_FACTOR } : DEFAULT_MODEL_WEIGHTS;
  let read = 0.1;
  if ((v.family === 'fable' || v.family === 'mythos') && v.major === 5 && (v.minor === 1 || v.minor === 2)) read = 0.025;
  else if ((v.family === 'opus' || v.family === 'sonnet') && v.major === 5 && v.minor === 5) read = 0.05;
  const newTokenizer =
    v.family === 'fable' ||
    v.family === 'mythos' ||
    (v.family === 'opus' && atLeast(v, 4, 7)) ||
    (v.family === 'sonnet' && atLeast(v, 5, 0)) ||
    (v.family === 'haiku' && atLeast(v, 5, 5));
  return { read, tokenizer: newTokenizer ? NEW_TOKENIZER_FACTOR : 1 };
}

/** Estimated tokens of `chars` characters of text on the given model. */
export const tokensFromChars = (chars: number, model: string | null | undefined): number => (chars / CHARS_PER_TOKEN) * modelWeights(model).tokenizer;
