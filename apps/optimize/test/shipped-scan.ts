// Static scan of the shipped artifacts (R1-06; owner's free-only rule 2026-11-26; legal note §1 rule 6 and §3):
// what a user installs must have no paid surface (licence key, checkout, price, sign-in, account), no telemetry and no
// network code of its own. It extends R0-03's source scan (no-network.test.ts) to the packaged output: the files of the
// npm tarball and of the built Claude Code plugin folder (R1-02), both passed to scanShipped.
// Pure: takes [path, text] pairs and returns findings; shipped-artifacts.e2e.test.ts runs it on the real tarball in
// `optimize:verify`, shipped-scan.test.ts proves every rule catches a planted example. An allow list widened here is a
// product decision: name the reason next to the entry.

export interface ShippedFile {
  path: string;
  text: string;
}

export interface Finding {
  file: string;
  rule: string;
  match: string;
}

/** Node built-ins the bundle may import (what src/ and the engine use today); anything else is a finding. */
export const ALLOWED_MODULES: ReadonlySet<string> = new Set(['node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:util']);

/** Documentation links a shipped file may contain, by URL prefix. Every other http(s) URL is a finding. */
export const ALLOWED_URL_PREFIXES: readonly string[] = [
  'https://crafthall.dev', // homepage and the $id of the token-usage JSON schema (an identifier, never fetched)
  'https://json-schema.org/draft/2020-12/schema', // $schema of the record and token-usage schemas (an identifier)
  'https://code.claude.com/docs/', // Claude Code documentation cited in user-facing text
  'https://www.anthropic.com/legal/', // Anthropic terms cited in user-facing text
];

/**
 * The child processes the bundle may start, as the first argument of each spawn/spawnSync call site: `git`, the
 * user's `claude` (`bin`, default "claude", in `claudeVersion` and `runChild`), the fixture's success command
 * (`runChild(control, command, …, shell: true)`) and `<tool> --version` of the tools that command names (`tool`,
 * fixture add). `file` is runChild's own parameter. Adding a child process means adding it here on purpose.
 */
export const ALLOWED_SPAWN_ARGS: ReadonlySet<string> = new Set(['"git"', 'bin', 'file', 'tool']);
/** runChild's call sites: the user's `claude` (bin) and the user's success command (command). */
export const ALLOWED_RUN_CHILD_ARGS: ReadonlySet<string> = new Set(['bin', 'command']);

/** HTTP clients and telemetry / analytics / crash-report packages (as NETWORK_PACKAGES in no-network.test.ts). */
const TELEMETRY = /@sentry\/|posthog|mixpanel|@segment\/|amplitude|newrelic|dd-trace|@datadog\/|applicationinsights|@opentelemetry\/|bugsnag|rollbar|logrocket|honeybadger|universal-analytics|@vercel\/analytics|undici|axios|node-fetch|cross-fetch|superagent|socket\.io/i;

/** Code rules, for .js/.mjs/.cjs files. */
const CODE_RULES: readonly [string, RegExp][] = [
  ['fetch call', /\bfetch\s*\(/],
  ['socket or beacon', /\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b|\bsendBeacon\s*\(/],
  ['telemetry or HTTP client package', TELEMETRY],
  ['dynamic code', /\beval\s*\(|\bnew\s+Function\s*\(|\bprocess\.binding\s*\(|\bcreateRequire\s*\(/],
  ['other child_process API', /(?<![.\w$])(exec|execSync|execFile|execFileSync|fork)\s*\(/],
];

/** Paid-surface phrases that have no legitimate use in a free tool – in code strings and in docs alike. */
const PAID_RULES: readonly [string, RegExp][] = [
  ['licence key', /\blicen[cs]e[ -]?keys?\b/i],
  ['checkout', /\bcheck[ -]?out\b/i],
  ['upgrade', /\bupgrade to\b|\bgo pro\b|\bpremium\b|\bpro tier\b|\bpaid (plan|tier|feature)s?\b/i],
  ['purchase', /\b(buy now|purchase|free trial|subscribe now|pricing)\b/i],
  ['price amount', /(?:USD|EUR|CHF|US\$|\$|€)\s?\d+(?:[.,]\d+)?\s*(?:\/|per|a)\s*(?:month|mo|year|yr|seat|user|workspace)\b/i],
];

/**
 * Sign-in, account, price and telemetry words, for code only (a README may truthfully say "no account, no sign-in,
 * no telemetry"). "account" and "price" appear in the cost qualifiers about the user's own Claude plan; only these
 * exact phrases are exempt (legal note §2.2), every other use is a finding.
 */
const CODE_TEXT_RULES: readonly [string, RegExp][] = [
  ['sign-in', /\bsign[ -]?(in|up|on)\b|\blog[ -]in\b|\blog in\b|\bauthenticate with crafthall\b/i],
  ['account or price', /\baccounts?\b|\bprices?\b/i],
  ['telemetry', /\btelemetry\b|\banalytics\b/i],
];
export const EXEMPT_PHRASES: readonly string[] = [
  'your subscription price', // SUBSCRIPTION_QUALIFIER (engine labels.ts)
  'API list price', // subscription-capacity label (engine labels.ts)
  'your own Claude account', // MEASURING_QUALIFIER (engine labels.ts)
  "key's API account", // KEY_SET_IN_SUBSCRIPTION warning (compare)
];

const isCode = (path: string): boolean => /\.[cm]?js$/.test(path);
const URL_RE = /https?:\/\/[^\s"'`)<>\]]+/g;
const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:^|[\s;])(?:import\s[^"'`;]*?from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/gm)].map((m) => m[1]!);

/** Findings for one shipped file. */
export function scanFile(file: ShippedFile): Finding[] {
  const out: Finding[] = [];
  const hit = (rule: string, re: RegExp, text: string) => {
    const m = re.exec(text);
    if (m) out.push({ file: file.path, rule, match: m[0] });
  };
  for (const url of file.text.match(URL_RE) ?? [])
    if (!ALLOWED_URL_PREFIXES.some((p) => url.startsWith(p))) out.push({ file: file.path, rule: 'URL outside the documentation allow list', match: url });
  for (const [rule, re] of PAID_RULES) hit(rule, re, file.text);
  if (file.path === 'package.json') {
    const pkg = JSON.parse(file.text) as Record<string, Record<string, string> | undefined>;
    for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'])
      if (pkg[k] && Object.keys(pkg[k]!).length) out.push({ file: file.path, rule: 'runtime dependency', match: `${k}: ${Object.keys(pkg[k]!).join(', ')}` });
    for (const s of ['preinstall', 'install', 'postinstall', 'prepare'])
      if (pkg.scripts?.[s]) out.push({ file: file.path, rule: 'install script', match: `${s}: ${pkg.scripts[s]}` });
  }
  if (!isCode(file.path)) return out;

  for (const m of importsOf(file.text)) if (!ALLOWED_MODULES.has(m)) out.push({ file: file.path, rule: 'module outside the allow list', match: m });
  for (const [rule, re] of CODE_RULES) hit(rule, re, file.text);
  let text = file.text;
  for (const p of EXEMPT_PHRASES) text = text.split(p).join('');
  for (const [rule, re] of CODE_TEXT_RULES) hit(rule, re, text);
  for (const m of file.text.matchAll(/\b(spawnSync|spawn)\s*\(\s*([^,)\s]+)/g))
    if (!ALLOWED_SPAWN_ARGS.has(m[2]!)) out.push({ file: file.path, rule: 'child process outside the allow list', match: m[0] });
  for (const m of file.text.matchAll(/(?<!function\s+)\brunChild\s*\(\s*control\s*,\s*([^,)\s]+)/g))
    if (!ALLOWED_RUN_CHILD_ARGS.has(m[1]!)) out.push({ file: file.path, rule: 'child process outside the allow list', match: m[0] });
  const shells = file.text.match(/\bshell:\s*true\b/g)?.length ?? 0;
  if (shells > 1) out.push({ file: file.path, rule: 'shell child outside the success command', match: `${shells} × shell: true` });
  return out;
}

export const scanShipped = (files: readonly ShippedFile[]): Finding[] => files.flatMap(scanFile);

/** The spawn call sites of one code file (first argument), for the "not vacuous" check of the E2E. */
export const spawnSites = (text: string): string[] => [
  ...[...text.matchAll(/\b(spawnSync|spawn)\s*\(\s*([^,)\s]+)/g)].map((m) => `${m[1]}(${m[2]})`),
  ...[...text.matchAll(/(?<!function\s+)\brunChild\s*\(\s*control\s*,\s*([^,)\s]+)/g)].map((m) => `runChild(${m[1]})`),
];
