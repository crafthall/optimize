// Share-safe export of a comparison record (`report --redact`, R0-03; legal note §1 rule 3). A stored record
// already holds no text, no absolute path and no identity, but its salted hashes, commit ids, fixture names and
// changed-file paths still link it to one repository and one person's store. The redacted copy replaces each of them
// with a value derived from a throwaway salt that is never stored or printed, so equal values stay equal inside the
// copy (the analysis can be re-read) but nothing links back to the user's store, repository or task names. The
// figures, versions, labels and verdict are kept: they are what a shared record is for.

import { contentHash, sha256Hex } from './hash';
import { assertStorable, comparisonId, RecordPrivacyError, serializeRecord, type ComparisonRecordV1 } from './records';
import type { PrivacyContext } from './privacy';

/** Repo-relative config paths that stay visible: they name Claude Code's own files, not a person or a project. */
export const SHARE_SAFE_PATHS: ReadonlySet<string> = new Set([
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
]);

/** Folders of `.claude/` whose kind stays visible (the file name inside is replaced). */
const CONFIG_KINDS = new Set(['agents', 'skills', 'commands', 'rules', 'hooks', 'output-styles']);

const extension = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(base);
  return m && m.index > 0 ? m[1]! : '';
};

/** The share-safe form of one changed-file path; `n` numbers the replaced ones. */
export function redactPath(path: string, n: number): string {
  if (SHARE_SAFE_PATHS.has(path)) return path;
  const parts = path.split('/');
  const name = `redacted-${n}`;
  if (parts[0] === '.claude' && parts.length > 2 && CONFIG_KINDS.has(parts[1]!)) {
    if (parts[1] === 'skills' && parts[parts.length - 1] === 'SKILL.md') return `.claude/skills/${name}/SKILL.md`;
    return `.claude/${parts[1]}/${name}${extension(path)}`;
  }
  if (parts[parts.length - 1] === 'CLAUDE.md') return `${name}/CLAUDE.md`;
  return `${name}${extension(path)}`;
}

export interface RedactOptions extends PrivacyContext {
  /** One-off salt (random, at least 32 hex characters), never stored or printed. */
  salt: string;
}

/**
 * The share-safe copy of a comparison record: hashes re-salted, commit ids replaced, fixture names `task-1…`, changed
 * files reduced to Claude Code config names, creation time cut to the day (and the id recomputed). Validates against
 * the schema and passes the privacy guard; throws RecordPrivacyError if any original identifier survives.
 */
export function redactRecord(record: ComparisonRecordV1, options: RedactOptions): ComparisonRecordV1 {
  if (!/^[0-9a-f]{32,}$/.test(options.salt)) throw new RangeError('redactRecord: the salt must be at least 32 lower-case hex characters');
  const salt = options.salt;
  const hash = (h: string): string => contentHash(h, salt);
  const names = new Map(record.fixtures.map((f, i) => [f.name, `task-${i + 1}`]));
  const nameOf = (n: string): string => {
    if (!names.has(n)) names.set(n, `task-${names.size + 1}`);
    return names.get(n)!;
  };
  const commit = (c: string): string => sha256Hex(`${salt}\u0000commit\u0000${c}`).slice(0, c.length === 64 ? 64 : 40);
  let replaced = 0;
  const changedFiles = [...new Set(record.change.changedFiles.map((p) => (SHARE_SAFE_PATHS.has(p) ? p : redactPath(p, ++replaced))))].sort();
  const createdAt = `${record.createdAt.slice(0, 10)}T00:00:00Z`;
  const hashes = { config: hash(record.hashes.config), diff: hash(record.hashes.diff), pluginList: hash(record.hashes.pluginList) };
  const redacted: ComparisonRecordV1 = {
    ...record,
    id: comparisonId(createdAt, hashes.diff),
    createdAt,
    hashes,
    change: { changedFiles },
    fixtures: record.fixtures.map((f) => ({ name: nameOf(f.name), commit: commit(f.commit), promptHash: hash(f.promptHash) })),
    arms: record.arms.map((a) => ({ arm: a.arm, configHash: hash(a.configHash) })),
    runs: record.runs.map((r) => ({ ...r, fixture: nameOf(r.fixture) })),
  };
  // Long original identifiers (hashes, commit ids, the record id) must not survive anywhere, verdict text included.
  const text = serializeRecord(redacted);
  const originals = [
    record.id,
    ...Object.values(record.hashes),
    ...record.fixtures.flatMap((f) => [f.commit, f.promptHash]),
    ...record.arms.map((a) => a.configHash),
  ];
  if (originals.some((o) => text.includes(o.slice(o.indexOf(':') + 1))))
    throw new RecordPrivacyError([{ path: '', kind: 'identity' }]);
  return assertStorable(redacted, { identities: options.identities });
}
