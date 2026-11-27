// node:fs adapter of the engine's StoreFs port and the repo-root lookup. The only file I/O of the CLI; commands
// (–) open the store through openStore. The store is <repo>/.crafthall/optimize/ (ADR-0001).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { initStore, type StoreFs, type StoreLayout } from '@crafthall/optimize-engine';

export const nodeStoreFs: StoreFs = {
  readText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
  writeText: (p, text) => writeFileSync(p, text, { encoding: 'utf8', mode: 0o600 }),
  mkdirp: (p) => void mkdirSync(p, { recursive: true, mode: 0o700 }),
  list: (p) => (existsSync(p) ? readdirSync(p) : []),
  remove: (p) => {
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  },
};

/** Nearest directory at or above `start` that holds `.git` (a directory or a worktree file); null outside a repo. */
export function findRepoRoot(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Creates (if needed) and returns the store of the repo that contains `cwd`; null outside a git repo. */
export function openStore(cwd: string, fs: StoreFs = nodeStoreFs): { repoRoot: string; layout: StoreLayout } | null {
  const repoRoot = findRepoRoot(cwd);
  return repoRoot ? { repoRoot, layout: initStore(fs, repoRoot) } : null;
}
