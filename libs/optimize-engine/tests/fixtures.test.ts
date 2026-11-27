import { describe, expect, it } from 'vitest';
import {
  createFixture,
  describeFixture,
  ensureSalt,
  FIXTURE_DEFAULTS,
  isFixtureName,
  listFixtures,
  oracleToolCandidates,
  parseCap,
  parseToolVersion,
  readFixture,
  removeFixture,
  writeFixture,
} from '../src/index';
import { fixtureInput, memoryFs, REPO, validFixture } from './samples';

describe('fixture helpers (R0-05)', () => {
  it('defaults follow release r0 §4', () => {
    expect(FIXTURE_DEFAULTS).toEqual({ commit: 'HEAD', timeoutMin: 15, maxBudgetUsd: 0.5 });
  });

  it.each([
    ['calc-core-rounding', true],
    ['f1', true],
    ['-lead', false],
    ['Upper', false],
    ['a'.repeat(64), false],
    ['../x', false],
    ['', false],
  ])('isFixtureName(%j) → %s', (name, ok) => expect(isFixtureName(name)).toBe(ok));

  it.each([
    ['15', 'timeoutMin', 15],
    ['0.5', 'maxBudgetUsd', 0.5],
    ['.25', 'maxBudgetUsd', 0.25],
    ['240', 'timeoutMin', 240],
    ['241', 'timeoutMin', null],
    ['0', 'timeoutMin', null],
    ['-1', 'timeoutMin', null],
    ['1e3', 'maxBudgetUsd', null],
    ['abc', 'maxBudgetUsd', null],
    ['', 'maxBudgetUsd', null],
    [undefined, 'maxBudgetUsd', null],
  ] as const)('parseCap(%j, %s) → %s', (v, cap, expected) => expect(parseCap(v, cap)).toBe(expected));

  it('oracle tool candidates: first word of each segment, known tools only, never a script or path', () => {
    expect(oracleToolCandidates('npm test')).toEqual(['node', 'npm']);
    expect(oracleToolCandidates('CI=1 npx nx test calc-core && python3 -m pytest | tee out.txt; make lint')).toEqual(['make', 'node', 'npx', 'python3']);
    expect(oracleToolCandidates('./run-tests.sh && rm -rf x')).toEqual(['node']);
  });

  it.each([
    ['v24.21.0\n', '24.21.0'],
    ['Python 3.12.1', '3.12.1'],
    ['go version go1.22.3 darwin/arm64', '1.22.3'],
    ['10.9.2', '10.9.2'],
    ['GNU Make 3.81\nCopyright', '3.81'],
    ['1.2.3-beta.1+build', '1.2.3-beta.1+build'],
    ['no version here', null],
  ])('parseToolVersion(%j) → %j', (text, v) => expect(parseToolVersion(text)).toBe(v));

  it('describeFixture gives one list row', () => {
    expect(describeFixture(validFixture())).toEqual({ name: 'calc-core-rounding', commit: 'aaaaaaaaaaaa', check: 'npx nx test calc-core', caps: '15 min, $0.50', createdAt: '2026-11-26T10:15:00Z' });
  });
});

describe('store: salt and remove', () => {
  it('creates the salt once and reuses it; refuses a malformed salt', () => {
    const fs = memoryFs();
    const salt = ensureSalt(fs, REPO, () => 'ab'.repeat(32));
    expect(salt).toBe('ab'.repeat(32));
    expect(ensureSalt(fs, REPO, () => 'cd'.repeat(32))).toBe(salt);
    fs.files.set(`${REPO}/.crafthall/optimize/salt`, 'not hex\n');
    expect(() => ensureSalt(fs, REPO, () => 'cd'.repeat(32))).toThrow(/malformed/);
    expect(() => ensureSalt(memoryFs(), REPO, () => 'short')).toThrow(/hex/);
  });

  it('a salted fixture hash differs from the unsalted one and the salt never enters the record', () => {
    const salt = 'ab'.repeat(32);
    const salted = createFixture(fixtureInput({ salt }));
    expect(salted.promptHash).toMatch(/^sha256-salted:[0-9a-f]{64}$/);
    expect(salted.promptHash).not.toBe(createFixture(fixtureInput()).promptHash);
    expect(JSON.stringify(salted)).not.toContain(salt);
  });

  it('removeFixture deletes one fixture and reports a missing or invalid name', () => {
    const fs = memoryFs();
    writeFixture(fs, REPO, validFixture());
    writeFixture(fs, REPO, { ...validFixture(), name: 'other' });
    expect(removeFixture(fs, REPO, 'calc-core-rounding')).toBe(true);
    expect(listFixtures(fs, REPO)).toEqual(['other']);
    expect(readFixture(fs, REPO, 'calc-core-rounding').ok).toBe(false);
    expect(removeFixture(fs, REPO, 'calc-core-rounding')).toBe(false);
    expect(removeFixture(fs, REPO, '../salt')).toBe(false);
    expect(fs.files.has(`${REPO}/.crafthall/optimize/.gitignore`)).toBe(true);
  });
});
