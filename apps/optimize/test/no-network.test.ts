// Static guard (ADR-0001, R0-03, R0-14, legal note §1 rule 6): no source file of the CLI or the engine imports a network
// module, an HTTP client or a telemetry package, calls fetch or opens a socket, or imports Crafthall HQ code; and
// neither package.json declares such a dependency. ESLint enforces part of the rule; this test also covers code that
// lint might be told to ignore. The built bundle gets the same scan in test/cli.e2e.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = [join(import.meta.dirname, '..', 'src'), join(import.meta.dirname, '..', '..', '..', 'libs', 'optimize-engine', 'src')];
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

/** HTTP clients and telemetry / analytics / crash-report packages (R0-03: no telemetry, no network call). */
export const NETWORK_PACKAGES =
  /^(undici|axios|node-fetch|cross-fetch|got|ky|superagent|request|ws|socket\.io-client|@sentry\/.*|posthog-.*|mixpanel.*|@segment\/.*|analytics-node|@amplitude\/.*|amplitude-.*|newrelic|dd-trace|@datadog\/.*|applicationinsights|@opentelemetry\/.*|@vercel\/analytics|bugsnag.*|@bugsnag\/.*|rollbar|honeybadger.*|@honeybadger-io\/.*|logrocket|universal-analytics|ga4-.*)$/;

const importsOf = (text: string): string[] => [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);

export const FORBIDDEN: readonly [string, RegExp][] = [
  ['network module', /from\s+['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]|require\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]\s*\)/],
  ['fetch call', /\bfetch\s*\(/],
  ['socket or beacon', /\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b|\bsendBeacon\s*\(/],
  ['HQ import', /from\s+['"](@crafthall\/hq[^'"]*)['"]/],
];

describe('no network and no HQ code in Crafthall Optimize sources', () => {
  const files = ROOTS.flatMap(walk).filter((f) => /\.[cm]?[jt]s$/.test(f));
  it('scans at least the engine and CLI sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });
  for (const [what, re] of FORBIDDEN)
    it(`has no ${what}`, () => {
      expect(files.filter((f) => re.test(readFileSync(f, 'utf8')))).toEqual([]);
    });
  it('imports no HTTP client or telemetry package', () => {
    expect(files.flatMap((f) => importsOf(readFileSync(f, 'utf8')).filter((m) => NETWORK_PACKAGES.test(m)).map((m) => `${f}: ${m}`))).toEqual([]);
  });
  it('declares no HTTP client or telemetry dependency in either package.json', () => {
    const pkgs = [join(import.meta.dirname, '..', 'package.json'), join(import.meta.dirname, '..', '..', '..', 'libs', 'optimize-engine', 'package.json')];
    const deps = pkgs.flatMap((p) => {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(j[k] ?? {}));
    });
    expect(deps.filter((d) => NETWORK_PACKAGES.test(d))).toEqual([]);
  });
  it('the guard is not vacuous: it catches a planted import of each kind', () => {
    const planted = ["import { request } from 'node:https';", "const r = await fetch('https://x.invalid');", "import * as Sentry from '@sentry/node';", 'new WebSocket(url)'];
    expect(planted.map((t) => FORBIDDEN.some(([, re]) => re.test(t)) || importsOf(t).some((m) => NETWORK_PACKAGES.test(m)))).toEqual([true, true, true, true]);
  });
});
