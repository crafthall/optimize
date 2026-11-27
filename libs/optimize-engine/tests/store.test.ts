import { describe, expect, it } from 'vitest';
import {
  createComparisonRecord,
  createFixture,
  initStore,
  listFixtures,
  readComparison,
  readFixture,
  STORE_DIR,
  STORE_GITIGNORE,
  storeLayout,
  writeComparison,
  writeFixture,
} from '../src/index';
import { comparisonInput, fixtureInput, memoryFs, REPO, validFixture } from './samples';

describe('local store', () => {
  it('lives in <repo>/.crafthall/optimize with its own .gitignore', () => {
    expect(STORE_DIR).toBe('.crafthall/optimize');
    expect(storeLayout('/r/repo/')).toEqual({
      root: '/r/repo/.crafthall/optimize',
      gitignore: '/r/repo/.crafthall/optimize/.gitignore',
      salt: '/r/repo/.crafthall/optimize/salt',
      fixturesDir: '/r/repo/.crafthall/optimize/fixtures',
      recordsDir: '/r/repo/.crafthall/optimize/records',
    });
    const fs = memoryFs();
    initStore(fs, REPO);
    expect(fs.files.get(`${REPO}/.crafthall/optimize/.gitignore`)).toBe(STORE_GITIGNORE);
    expect(STORE_GITIGNORE.split('\n')).toContain('*');
  });

  it('keeps an existing .gitignore', () => {
    const fs = memoryFs();
    fs.files.set(`${REPO}/.crafthall/optimize/.gitignore`, 'custom\n');
    initStore(fs, REPO);
    expect(fs.files.get(`${REPO}/.crafthall/optimize/.gitignore`)).toBe('custom\n');
  });

  it('round-trips a fixture and a comparison record', () => {
    const fs = memoryFs();
    const f = createFixture(fixtureInput());
    expect(writeFixture(fs, REPO, f)).toBe(`${REPO}/.crafthall/optimize/fixtures/calc-core-rounding.json`);
    expect(readFixture(fs, REPO, 'calc-core-rounding')).toEqual({ ok: true, record: f });
    expect(listFixtures(fs, REPO)).toEqual(['calc-core-rounding']);
    const r = createComparisonRecord(comparisonInput());
    writeComparison(fs, REPO, r);
    expect(readComparison(fs, REPO, r.id)).toEqual({ ok: true, record: r });
  });

  it('refuses to write a record that fails the schema', () => {
    const fs = memoryFs();
    const bad = { ...validFixture(), extra: 'x' } as unknown as ReturnType<typeof validFixture>;
    expect(() => writeFixture(fs, REPO, bad)).toThrow(/schema/);
    expect([...fs.files.keys()].some((p) => p.endsWith('.json'))).toBe(false);
  });

  it('reports missing, corrupt, wrong-kind and traversal reads without throwing', () => {
    const fs = memoryFs();
    expect(readFixture(fs, REPO, 'none').ok).toBe(false);
    expect(readFixture(fs, REPO, '../../etc/passwd').ok).toBe(false);
    expect(readComparison(fs, REPO, '../x').ok).toBe(false);
    fs.files.set(`${REPO}/.crafthall/optimize/fixtures/broken.json`, '{not json');
    expect(readFixture(fs, REPO, 'broken')).toEqual({ ok: false, errors: [{ path: '', message: 'not valid JSON' }] });
    const r = createComparisonRecord(comparisonInput());
    fs.files.set(`${REPO}/.crafthall/optimize/fixtures/wrong.json`, JSON.stringify(r));
    expect(readFixture(fs, REPO, 'wrong').ok).toBe(false);
  });
});
