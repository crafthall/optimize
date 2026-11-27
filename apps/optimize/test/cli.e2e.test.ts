// E2E of the built binary (R0-14 part of): `crafthall-optimize --version` and `--help` run in a clean HOME, in a
// directory that is no git repo and has no `.claude/` HQ files, with no Crafthall HQ installed and the shared E2E
// PATH (e2ePath: node, git, /usr/bin, /bin; no `claude`). The bundle must hold no network module and no HQ code, and running it must not create files.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@crafthall/optimize-engine';
import { BUNDLE, e2ePath, runCli } from './e2e-path';

const home = mkdtempSync(join(tmpdir(), 'optimize-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'optimize-cwd-'));
afterAll(() => [home, cwd].forEach((d) => rmSync(d, { recursive: true, force: true })));

const runBin = (...args: string[]) =>
  runCli(args, { cwd, timeout: 20_000, env: { HOME: home, USERPROFILE: home, PATH: e2ePath(), NO_COLOR: '1' } });

describe('crafthall-optimize binary (built)', () => {
  it('exists and is a self-contained ESM bundle with a node shebang', () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const text = readFileSync(BUNDLE, 'utf8');
    expect(text.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(text).not.toMatch(/from\s*["']@crafthall\/(?!optimize-engine)/);
  });

  it('bundle has no network module, no fetch and no Crafthall HQ code', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    expect(text).not.toMatch(/["'](node:)?(http|https|http2|net|tls|dgram|dns)["']/);
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/crafthall-hq|@crafthall\/hq/i);
  });

  it('bundle opens no socket and carries no telemetry or HTTP client package (R0-03)', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    expect(text).not.toMatch(/\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b|\bsendBeacon\s*\(/);
    expect(text).not.toMatch(/@sentry\/|posthog|mixpanel|@segment\/|amplitude|newrelic|dd-trace|@datadog\/|applicationinsights|@opentelemetry\/|bugsnag|rollbar|undici|axios|node-fetch/i);
  });

  it('--version exits 0 with the version and the record schema version, HQ absent', () => {
    expect(existsSync(join(home, '.claude'))).toBe(false);
    const r = runBin('--version');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(new RegExp(`^crafthall-optimize \\d+\\.\\d+\\.\\d+ beta \\(record schema ${SCHEMA_VERSION.replace(/\./g, '\\.')}\\)\\n$`));
  });

  it('--help exits 0 and lists the commands', () => {
    const r = runBin('--help');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    for (const c of ['fixture add', 'compare', 'import-usage', 'report', '--version']) expect(r.stdout).toContain(c);
  });

  it('an unknown command exits 2 on stderr', () => {
    const r = runBin('nope');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown command');
  });

  it('creates no file in HOME or the working directory', () => {
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
  });
});
