// Privacy guard for every record the engine builds or writes (legal note §1 rules 1–3). The schema already keeps text
// out by shape; this guard scans every string that remains (keys and values) for things that must never be stored:
// absolute paths, secret-shaped strings, e-mail addresses, and the caller's own identity tokens (user name, host name,
// git author name and e-mail, branch name – the CLI passes them, the engine never reads the environment).
// R0-03: the never-stored list below is the one place that names what a record must never hold; the schema
// keeps text out by shape (only hashes, counts, ids and repo-relative paths have fields) and this guard catches the rest.

export type LeakKind = 'absolute-path' | 'secret' | 'email' | 'identity';

export interface PrivacyLeak {
  /** JSON Pointer of the string that leaks. */
  path: string;
  kind: LeakKind;
}

export interface PrivacyContext {
  /** Identity tokens of this machine and repo that must not appear in a record (user, host, git name/e-mail, branch). */
  identities?: readonly string[];
}

/**
 * What Optimize never stores, in any record or redacted export (legal note §1 rules 1–2, r0 R0-03). Text categories
 * have no field in the schema; the rest is caught by `findPrivacyLeaks`.
 */
export const NEVER_STORED: readonly string[] = [
  'prompt text',
  'file content',
  'tool output',
  'secrets',
  'credentials',
  'absolute paths',
  'user names',
  'host names',
  'git author names and e-mails (each word of a multi-word name too)',
  'branch names',
];

/**
 * A token that starts an absolute path: POSIX root, home `~/`, a Windows drive or a UNC share. A single lower-case
 * segment such as `/usage` or `/effort` is a Claude Code slash command, not a path: it names no person, host
 * or project. Two segments (`/opt/tool`), an upper-case segment (`/Users`) or a file name (`/x.js`) still count.
 */
const ABSOLUTE_PATH =
  /(?:^|[\s"'=:(,;])(?:\/(?![a-z][a-z0-9-]*(?:$|[\s"'`),;:!?]|\.(?![A-Za-z0-9])))(?=[A-Za-z0-9._-])|~[\\/]|[A-Za-z]:[\\/]|\\\\[A-Za-z0-9])/;

/** Secret-shaped strings: provider key prefixes, private-key blocks, `key=value` assignments of credentials. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|secret|passw(?:or)?d|auth)\s*[=:]\s*['"]?[^\s'"]{8,}/i,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Identity tokens shorter than this are ignored: a two-letter user name would match half of every record. */
export const MIN_IDENTITY_LENGTH = 3;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Common words that name no person, machine or customer. A git user name "Test User" or a CI account
 * "runner" would otherwise refuse every `npm test` or `node user.js`. Compared case-insensitively against each token,
 * the whole identity included: a user name that is only "admin" identifies nobody. A multi-word identity still
 * matches as a whole ("Test User" in a text is a leak).
 */
export const IDENTITY_STOP_WORDS: ReadonlySet<string> = new Set([
  'test', 'tests', 'testing', 'user', 'users', 'admin', 'administrator', 'root', 'guest', 'owner', 'team', 'name',
  'dev', 'developer', 'build', 'builder', 'bot', 'runner', 'agent', 'default', 'local', 'localhost', 'host', 'server',
  'main', 'master', 'trunk', 'develop', 'release', 'feature', 'fix', 'docs', 'the', 'and', 'for', 'with', 'new', 'demo',
  'example', 'sample', 'node', 'npm', 'git', 'github', 'gitlab', 'code', 'claude', 'app', 'check', 'run', 'fixture',
  'ubuntu', 'debian', 'linux', 'mac', 'macbook', 'pro', 'air', 'laptop', 'desktop', 'home', 'work', 'workstation',
]);

/**
 * The identity tokens to look for: each identity as given plus every word of a multi-word one (a git user name
 * "Jane Q Doe" also yields "Jane" and "Doe"), trimmed, unique, at least MIN_IDENTITY_LENGTH characters and not a
 * common word of IDENTITY_STOP_WORDS. Matching is whole-token (findPrivacyLeaks).
 */
export function identityTokens(identities: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const raw of identities) {
    const id = raw.trim();
    for (const t of [id, ...(/\s/.test(id) ? id.split(/\s+/) : [])])
      if (t.length >= MIN_IDENTITY_LENGTH && !IDENTITY_STOP_WORDS.has(t.toLowerCase())) out.add(t);
  }
  return [...out];
}

/** Finds every string in `value` (keys included) that would leak private data. Pure; never throws. */
export function findPrivacyLeaks(value: unknown, context: PrivacyContext = {}): PrivacyLeak[] {
  const identities = identityTokens(context.identities).map((s) => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(s)}(?:$|[^A-Za-z0-9])`, 'i'));
  const leaks: PrivacyLeak[] = [];
  const check = (s: string, path: string): void => {
    if (ABSOLUTE_PATH.test(s)) leaks.push({ path, kind: 'absolute-path' });
    if (SECRET_PATTERNS.some((r) => r.test(s))) leaks.push({ path, kind: 'secret' });
    if (EMAIL.test(s)) leaks.push({ path, kind: 'email' });
    if (identities.some((r) => r.test(s))) leaks.push({ path, kind: 'identity' });
  };
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') check(v, path);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        check(k, `${path}/${k}`);
        walk(x, `${path}/${k}`);
      }
  };
  walk(value, '');
  return leaks;
}

/**
 * Turns a path the user gave (absolute or relative to the repo, POSIX or Windows separators) into the repo-relative
 * POSIX path a record may hold. Returns null when the path is outside the repo – such a path is never stored.
 */
export function toRepoRelativePath(path: string, repoRoot: string): string | null {
  const norm = (p: string): string[] => p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  const isAbs = (p: string): boolean => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
  const resolve = (segments: string[]): string[] | null => {
    const out: string[] = [];
    for (const s of segments) {
      if (s === '..') {
        if (!out.length) return null;
        out.pop();
      } else out.push(s);
    }
    return out;
  };
  if (!isAbs(repoRoot)) throw new Error('repoRoot must be an absolute path');
  const root = resolve(norm(repoRoot));
  const full = resolve(isAbs(path) ? norm(path) : [...norm(repoRoot), ...norm(path)]);
  if (!root || !full || full.length <= root.length) return null;
  const caseFold = /^[A-Za-z]:/.test(repoRoot) ? (s: string) => s.toLowerCase() : (s: string) => s;
  for (let i = 0; i < root.length; i++) if (caseFold(root[i]!) !== caseFold(full[i]!)) return null;
  return full.slice(root.length).join('/');
}
