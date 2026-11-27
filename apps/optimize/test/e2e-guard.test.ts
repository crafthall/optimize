// Guard: no E2E may reach the real `claude`. Every *.e2e.test.ts must take its PATH from e2ePath and spawn
// the built CLI only through runCli (test/e2e-path.ts), which checks what `claude` resolves to before each run.
// A static scan fails on any E2E file that builds a PATH by hand, spawns node or the bundle itself, or calls `claude`;
// runtime checks pin the helper: no stub → no `claude`, a foreign `claude` on PATH → refused.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertNoRealClaude, e2ePath, resolveClaude, runCli, writeStubClaude } from './e2e-path';

/** The rule violations of one E2E file's source; empty when it is safe. */
function e2eGuardViolations(source: string): string[] {
  const out: string[] = [];
  if (!/from '\.\/e2e-path'/.test(source)) out.push('does not import ./e2e-path');
  if (/process\.execPath/.test(source)) out.push('uses process.execPath (spawn the CLI with runCli)');
  if (/\bPATH\s*:(?!\s*e2ePath\()/.test(source)) out.push('sets a PATH that is not e2ePath(...)');
  if (/\bPATH\s*=/.test(source)) out.push('assigns PATH directly');
  if (/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\([^)]*\bBUNDLE\b/.test(source)) out.push('spawns the bundle without runCli');
  if (/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`][^'"`]*\bclaude\b/.test(source)) out.push('spawns claude directly');
  if (/(?:writeFileSync|copyFileSync|symlinkSync)\s*\([^;]*['"`]claude['"`]/.test(source)) out.push('writes a claude binary without writeStubClaude');
  return out;
}

const TEST_DIR = import.meta.dirname;
const e2eFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith('.e2e.test.ts'));

describe('every E2E file uses the PATH helper (#1118)', () => {
  it('finds the E2E files', () => expect(e2eFiles.length).toBeGreaterThanOrEqual(6));
  it.each(e2eFiles)('%s', (file) => expect(e2eGuardViolations(readFileSync(join(TEST_DIR, file), 'utf8'))).toEqual([]));

  it('the scan catches each unsafe pattern (incident shapes of 2026-11-26 included)', () => {
    const ok = "import { e2ePath, runCli } from './e2e-path';\nconst env = { PATH: e2ePath() };\nrunCli(['--version'], { cwd, env });\n";
    expect(e2eGuardViolations(ok)).toEqual([]);
    const bad = [
      "const env = { PATH: dirname(process.execPath) };",
      "import { e2ePath } from './e2e-path';\nconst env = { PATH: `${dirname(node)}:/usr/bin` };",
      "import { e2ePath } from './e2e-path';\nconst env = { PATH: [a, b].join(':') };",
      "import { e2ePath } from './e2e-path';\nconst env = { PATH: basePath };",
      "import { e2ePath } from './e2e-path';\nprocess.env.PATH = '/x';",
      "import { e2ePath } from './e2e-path';\nspawnSync(node, [BUNDLE, 'compare'], { env });",
      "import { e2ePath } from './e2e-path';\nexecFileSync('claude', ['-p']);",
      "import { e2ePath } from './e2e-path';\nwriteFileSync(join(dir, 'claude'), src);",
    ];
    for (const s of bad) expect(e2eGuardViolations(s), s).not.toEqual([]);
  });
});

describe('the PATH helper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optimize-guard-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('without a stub, `claude` resolves to nothing; node and git resolve', () => {
    const path = e2ePath();
    expect(resolveClaude(path)).toBeNull();
    expect(path.split(':')).not.toContain(join(process.execPath, '..'));
  });

  it('with a registered stub first, `claude` resolves to the stub', () => {
    const stub = writeStubClaude(join(dir, 'stub'), '#!/bin/sh\necho stub\n');
    expect(resolveClaude(e2ePath(join(dir, 'stub')))).toBe(stub);
  });

  it('refuses a PATH whose `claude` is not a registered stub, and an env without PATH, before spawning', () => {
    mkdirSync(join(dir, 'foreign'));
    writeFileSync(join(dir, 'foreign', 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'foreign', 'claude'), 0o755);
    expect(() => e2ePath(join(dir, 'foreign'))).toThrow(/no test stub/);
    expect(() => assertNoRealClaude(`${join(dir, 'foreign')}:/usr/bin:/bin`)).toThrow(/no test stub/);
    expect(() => runCli(['--version'], { cwd: dir, env: { PATH: `${join(dir, 'foreign')}:/bin` } })).toThrow(/no test stub/);
    expect(() => runCli(['--version'], { cwd: dir, env: {} })).toThrow(/no PATH/);
  });
});
