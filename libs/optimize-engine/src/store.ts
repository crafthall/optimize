// The local store of Crafthall Optimize (ADR-0001): `<repo>/.crafthall/optimize/` with its own `.gitignore` (`*`), so
// fixtures and records never reach a commit by accident. Layout:
//   .crafthall/optimize/.gitignore
//   .crafthall/optimize/config.json     (local settings: billing mode)
//   .crafthall/optimize/salt            (per-store salt of the prompt hashes; never in a record)
//   .crafthall/optimize/fixtures/<name>.json
//   .crafthall/optimize/records/<id>.json
// The engine does no I/O itself: every helper takes a StoreFs port. The CLI passes a node:fs adapter; tests pass an
// in-memory map; a browser shell (HQ, later) would pass a read-only one.

import { isBillingMode, type BillingMode } from './labels';
import type { PrivacyContext } from './privacy';
import { assertStorable, parseRecord, serializeRecord, type ComparisonRecordV1, type FixtureV1, type ParseResult } from './records';
import type { SchemaError } from './validate';

/** Store directory, relative to the repository root. */
export const STORE_DIR = '.crafthall/optimize';
export const STORE_GITIGNORE = '# Crafthall Optimize local store (fixtures and comparison records). Never commit it.\n*\n';

/** Minimal synchronous file port. Paths are the strings the helpers build: `<repoRoot>/.crafthall/optimize/...`. */
export interface StoreFs {
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  mkdirp(path: string): void;
  /** File names (not paths) in a directory; [] when it does not exist. */
  list(path: string): string[];
  /** Deletes a file; false when it did not exist. */
  remove(path: string): boolean;
}

export interface StoreLayout {
  root: string;
  gitignore: string;
  salt: string;
  fixturesDir: string;
  recordsDir: string;
}

const join = (...parts: string[]): string => parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join('/');

export function storeLayout(repoRoot: string): StoreLayout {
  const root = join(repoRoot, STORE_DIR);
  return { root, gitignore: join(root, '.gitignore'), salt: join(root, 'salt'), fixturesDir: join(root, 'fixtures'), recordsDir: join(root, 'records') };
}

/** Creates the store and its `.gitignore` when missing; leaves an existing `.gitignore` alone. Returns the layout. */
export function initStore(fs: StoreFs, repoRoot: string): StoreLayout {
  const layout = storeLayout(repoRoot);
  fs.mkdirp(layout.fixturesDir);
  fs.mkdirp(layout.recordsDir);
  if (fs.readText(layout.gitignore) === undefined) fs.writeText(layout.gitignore, STORE_GITIGNORE);
  return layout;
}

const SALT = /^[0-9a-f]{32,128}$/;

/**
 * The per-store salt of prompt hashes (legal note §1 rule 3): read from the store, or created with `generate` (the CLI
 * passes 32 random bytes as hex) on first use. A malformed salt file is an error, not silently replaced – replacing it
 * would make every stored prompt hash unverifiable.
 */
export function ensureSalt(fs: StoreFs, repoRoot: string, generate: () => string): string {
  const layout = initStore(fs, repoRoot);
  const existing = fs.readText(layout.salt);
  if (existing !== undefined) {
    const salt = existing.trim();
    if (!SALT.test(salt)) throw new Error(`the store salt file ${STORE_DIR}/salt is malformed; restore it or delete the store`);
    return salt;
  }
  const salt = generate();
  if (!SALT.test(salt)) throw new Error('generated salt must be 32–128 lower-case hex characters');
  fs.writeText(layout.salt, `${salt}\n`);
  return salt;
}

/** Validates, privacy-checks and writes a fixture; returns the file path. Throws RecordSchemaError / RecordPrivacyError. */
export function writeFixture(fs: StoreFs, repoRoot: string, fixture: FixtureV1, context: PrivacyContext = {}): string {
  assertStorable(fixture, context);
  const path = join(initStore(fs, repoRoot).fixturesDir, `${fixture.name}.json`);
  fs.writeText(path, serializeRecord(fixture));
  return path;
}

/** Validates, privacy-checks and writes a comparison record; returns the file path. */
export function writeComparison(fs: StoreFs, repoRoot: string, record: ComparisonRecordV1, context: PrivacyContext = {}): string {
  assertStorable(record, context);
  const path = join(initStore(fs, repoRoot).recordsDir, `${record.id}.json`);
  fs.writeText(path, serializeRecord(record));
  return path;
}

const notFound = (what: string): ParseResult<never> => ({ ok: false, errors: [{ path: '', message: `${what} not found` }] });
const ofKind = <T>(r: ParseResult<unknown>, kind: string): ParseResult<T> =>
  !r.ok ? r : (r.record as { kind: string }).kind === kind ? (r as ParseResult<T>) : { ok: false, errors: [{ path: '/kind', message: `expected a ${kind} record` }] as SchemaError[] };

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const badName = (what: string): ParseResult<never> => ({ ok: false, errors: [{ path: '', message: `invalid ${what}` }] });

export function readFixture(fs: StoreFs, repoRoot: string, name: string): ParseResult<FixtureV1> {
  if (!NAME.test(name)) return badName('fixture name');
  const text = fs.readText(join(storeLayout(repoRoot).fixturesDir, `${name}.json`));
  return text === undefined ? notFound(`fixture "${name}"`) : ofKind<FixtureV1>(parseRecord(text), 'fixture');
}

export function readComparison(fs: StoreFs, repoRoot: string, id: string): ParseResult<ComparisonRecordV1> {
  if (!ID.test(id)) return badName('record id');
  const text = fs.readText(join(storeLayout(repoRoot).recordsDir, `${id}.json`));
  return text === undefined ? notFound(`record "${id}"`) : ofKind<ComparisonRecordV1>(parseRecord(text), 'comparison');
}

/** Deletes a fixture file; false when the name is invalid or no such fixture exists. */
export function removeFixture(fs: StoreFs, repoRoot: string, name: string): boolean {
  if (!NAME.test(name)) return false;
  return fs.remove(join(storeLayout(repoRoot).fixturesDir, `${name}.json`));
}

/** Fixture names in the store, sorted. */
export const listFixtures = (fs: StoreFs, repoRoot: string): string[] =>
  fs.list(storeLayout(repoRoot).fixturesDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

// ---------------------------------------------------------------------------------------------------------------
// Local settings (R0-10): `.crafthall/optimize/config.json`, inside the git-ignored store. Today one value, the
// billing mode set by `config set billing`; unknown keys are kept as they are.

export const configPath = (repoRoot: string): string => `${storeLayout(repoRoot).root}/config.json`;

function readConfig(fs: StoreFs, repoRoot: string): Record<string, unknown> {
  const text = fs.readText(configPath(repoRoot));
  if (text === undefined) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The stored billing mode, or null when unset or unreadable. */
export function readBilling(fs: StoreFs, repoRoot: string): BillingMode | null {
  const v = readConfig(fs, repoRoot).billing;
  return isBillingMode(v) ? v : null;
}

/** Stores the billing mode (creates the store and its `.gitignore` when missing). */
export function writeBilling(fs: StoreFs, repoRoot: string, mode: BillingMode): void {
  initStore(fs, repoRoot);
  fs.writeText(configPath(repoRoot), `${JSON.stringify({ ...readConfig(fs, repoRoot), billing: mode }, null, 2)}\n`);
}
