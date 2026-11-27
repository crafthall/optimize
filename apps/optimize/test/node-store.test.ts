import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, readFixture, STORE_GITIGNORE, writeFixture } from '@crafthall/optimize-engine';
import { findRepoRoot, nodeStoreFs, openStore } from '../src/node-store';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'optimize-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('node store adapter', () => {
  it('finds the repo root from a subdirectory (.git directory or worktree file)', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'a', 'b'), { recursive: true });
    expect(findRepoRoot(join(repo, 'a', 'b'))).toBe(repo);
    const wt = tmp();
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n');
    expect(findRepoRoot(wt)).toBe(wt);
  });

  it('openStore creates <repo>/.crafthall/optimize with its .gitignore; outside a repo it returns null', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    const s = openStore(repo)!;
    expect(s.layout.root).toBe(join(repo, '.crafthall', 'optimize'));
    expect(readFileSync(join(repo, '.crafthall', 'optimize', '.gitignore'), 'utf8')).toBe(STORE_GITIGNORE);
    expect(statSync(join(repo, '.crafthall', 'optimize', 'fixtures')).isDirectory()).toBe(true);
    expect(openStore(tmp())).toBeNull();
  });

  it('writes and reads a fixture on disk', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    const f = createFixture({
      name: 'f1',
      createdAt: '2026-11-26T10:00:00Z',
      commit: 'c'.repeat(40),
      promptText: 'do the thing',
      repoRoot: repo,
      check: 'npm test',
      caps: { timeoutMin: 15, maxBudgetUsd: 0.5 },
    });
    writeFixture(nodeStoreFs, repo, f);
    expect(readFixture(nodeStoreFs, repo, 'f1')).toEqual({ ok: true, record: f });
    expect(readFileSync(join(repo, '.crafthall', 'optimize', 'fixtures', 'f1.json'), 'utf8')).not.toContain('do the thing');
  });
});
