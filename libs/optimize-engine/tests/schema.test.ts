import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordSchemaV1, SCHEMA_VERSION, validateAgainst, validateRecord } from '../src/index';
import { validComparison, validFixture } from './samples';

// Tests mutate records into invalid shapes on purpose, so they need an untyped view.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mut = Record<string, any>;

const deepCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('record schema v1', () => {
  it('has a semver schemaVersion of major 1', () => {
    expect(SCHEMA_VERSION).toMatch(/^1\.\d+\.\d+$/);
  });

  it('committed schema/record-v1.schema.json equals the schema object (differential)', () => {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schema', 'record-v1.schema.json'), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(recordSchemaV1)));
  });

  it('accepts a valid fixture and a valid comparison record', () => {
    expect(validateRecord(validFixture())).toEqual([]);
    expect(validateRecord(validComparison())).toEqual([]);
  });

  it('accepts nullable result fields and an incomplete status', () => {
    const r = validComparison();
    r.status = 'incomplete';
    r.result.costRatio = null;
    r.result.ci95 = null;
    r.plan.paybackMonths = null;
    expect(validateRecord(r)).toEqual([]);
  });

  for (const field of recordSchemaV1.$defs.fixture.required) {
    it(`rejects a fixture without "${field}"`, () => {
      const f = deepCopy(validFixture()) as unknown as Record<string, unknown>;
      delete f[field];
      expect(validateRecord(f).length).toBeGreaterThan(0);
    });
  }

  for (const field of recordSchemaV1.$defs.comparison.required) {
    it(`rejects a comparison record without "${field}"`, () => {
      const r = deepCopy(validComparison()) as unknown as Record<string, unknown>;
      delete r[field];
      const errors = validateRecord(r);
      expect(errors.length).toBeGreaterThan(0);
      if (field !== 'kind') expect(errors.some((e) => e.message.includes(`"${field}"`))).toBe(true);
    });
  }

  it.each([
    ['unknown top-level field', (r: Mut) => (r['promptText'] = 'secret prompt')],
    ['absolute changed-file path', (r: Mut) => (r['change'].changedFiles = ['/Users/x/repo/a.md'])],
    ['parent-directory changed-file path', (r: Mut) => (r['change'].changedFiles = ['../a.md'])],
    ['Windows changed-file path', (r: Mut) => (r['change'].changedFiles = ['C:\\repo\\a.md'])],
    ['home changed-file path', (r: Mut) => (r['change'].changedFiles = ['~/repo/a.md'])],
    ['schema major 2', (r: Mut) => (r['schemaVersion'] = '2.0.0')],
    ['non-semver schemaVersion', (r: Mut) => (r['schemaVersion'] = '1.0')],
    ['raw hash without algorithm', (r: Mut) => (r['hashes'].diff = 'f'.repeat(64))],
    ['three arms', (r: Mut) => r['arms'].push({ arm: 'baseline', configHash: `sha256:${'e'.repeat(64)}` })],
    ['unknown arm', (r: Mut) => (r['runs'][0].arm = 'other')],
    ['negative tokens', (r: Mut) => (r['runs'][0].metrics.outputTokens = -1)],
    ['fractional tokens', (r: Mut) => (r['runs'][0].metrics.outputTokens = 1.5)],
    ['NaN-like cost', (r: Mut) => (r['runs'][0].metrics.totalCostUsd = 'NaN')],
    ['unknown exclusion reason', (r: Mut) => (r['exclusions'][0].reason = 'flaky')],
    ['unknown verdict code', (r: Mut) => (r['verdict'].code = 'saved')],
    ['ci95 with one bound', (r: Mut) => (r['result'].ci95 = [0.5])],
    ['extra field in metrics', (r: Mut) => (r['runs'][0].metrics.toolOutput = 'ls -la')],
    ['bad record id', (r: Mut) => (r['id'] = '../../etc/passwd')],
    ['overlong verdict text', (r: Mut) => (r['verdict'].text = 'x'.repeat(501))],
  ])('rejects a comparison record with %s', (_name, mutate) => {
    const r = deepCopy(validComparison()) as unknown as Mut;
    mutate(r);
    expect(validateRecord(r).length).toBeGreaterThan(0);
  });

  it.each([
    ['short commit', (f: Mut) => (f['commit'] = 'abc1234')],
    ['upper-case name', (f: Mut) => (f['name'] = 'Calc')],
    ['zero timeout', (f: Mut) => (f['caps'].timeoutMin = 0)],
    ['empty check', (f: Mut) => (f['check'] = '')],
    ['local-time timestamp', (f: Mut) => (f['createdAt'] = '2026-11-26T10:15:00+01:00')],
  ])('rejects a fixture with %s', (_name, mutate) => {
    const f = deepCopy(validFixture()) as unknown as Mut;
    mutate(f);
    expect(validateRecord(f).length).toBeGreaterThan(0);
  });

  it('rejects values that are not records', () => {
    for (const v of [null, 42, 'x', [], {}, { kind: 'other' }]) expect(validateRecord(v).length).toBeGreaterThan(0);
  });

  it('refuses a schema keyword it does not implement', () => {
    expect(() => validateAgainst({ format: 'date-time' }, 'x')).toThrow(/not supported/);
  });
});

// Schema 1.3.0: optional versions.modelByArm; records written before it stay valid.
describe('record schema 1.3.0: versions.modelByArm', () => {
  it('a record without modelByArm (1.2.0 and older) is valid; one with both arms or one arm is valid', () => {
    const old = { ...validComparison(), schemaVersion: '1.2.0' };
    expect(validateRecord(old)).toEqual([]);
    const both = { ...validComparison(), versions: { ...validComparison().versions, modelByArm: { baseline: 'claude-opus-5-5', changed: 'claude-sonnet-5-5' } } };
    expect(validateRecord(both)).toEqual([]);
    const one = { ...validComparison(), versions: { ...validComparison().versions, modelByArm: { changed: 'claude-sonnet-5-5' } } };
    expect(validateRecord(one)).toEqual([]);
  });

  it('rejects an unknown arm key and a model id outside the pattern', () => {
    const extra = { ...validComparison(), versions: { ...validComparison().versions, modelByArm: { other: 'x' } } };
    expect(validateRecord(extra).length).toBeGreaterThan(0);
    const bad = { ...validComparison(), versions: { ...validComparison().versions, modelByArm: { baseline: 'has space' } } };
    expect(validateRecord(bad).length).toBeGreaterThan(0);
  });
});
