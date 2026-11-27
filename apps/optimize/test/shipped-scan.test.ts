// The R1-06 scan (shipped-scan.ts) is not vacuous: each rule catches a planted example, and the exemptions are narrow.
// The scan of the real tarball runs in shipped-artifacts.e2e.test.ts (optimize:verify).
import { describe, expect, it } from 'vitest';
import { scanFile } from './shipped-scan';

const js = (text: string) => scanFile({ path: 'dist/x.mjs', text }).map((f) => f.rule);
const md = (text: string) => scanFile({ path: 'README.md', text }).map((f) => f.rule);

describe('shipped-artifact scan rules (R1-06)', () => {
  it('passes clean code that uses only the allowed modules and child processes', () => {
    const ok = [
      'import { spawn, spawnSync } from "node:child_process";',
      'import { join } from "node:path";',
      'spawnSync("git", args);',
      'const bin = options.claudeBin ?? "claude"; spawnSync(bin, ["--version"]);',
      'function runChild(control, file, args, opts) { spawn(file, [...args], { shell: opts.shell ?? false }); }',
      'await runChild(control, bin, args, {}); await runChild(control, command, [], { shell: true });',
      'const re = /x/.exec(s);',
      'var Q = "Comparisons run on your own Claude account and use your tokens; it does not lower your subscription price.";',
      'const id = "https://crafthall.dev/schemas/optimize/token-usage-1.json";',
    ].join('\n');
    expect(js(ok)).toEqual([]);
  });

  it.each([
    ['import { request } from "node:https";', 'module outside the allow list'],
    ['import net from "net";', 'module outside the allow list'],
    ['const u = await import("undici");', 'module outside the allow list'],
    ['require("http")', 'module outside the allow list'],
    ['await fetch(url)', 'fetch call'],
    ['new WebSocket(u)', 'socket or beacon'],
    ['navigator.sendBeacon(u, d)', 'socket or beacon'],
    ['const s = "@sentry/node";', 'telemetry or HTTP client package'],
    ['const p = "posthog-node";', 'telemetry or HTTP client package'],
    ['eval(code)', 'dynamic code'],
    ['const r = createRequire(import.meta.url);', 'dynamic code'],
    ['execSync("curl x")', 'other child_process API'],
    ['spawnSync("curl", ["x"])', 'child process outside the allow list'],
    ['spawn(cmd, [])', 'child process outside the allow list'],
    ['await runChild(control, "npm", [], {})', 'child process outside the allow list'],
    ['a({ shell: true }); b({ shell: true });', 'shell child outside the success command'],
    ['const k = "Enter your license key";', 'licence key'],
    ['const k = "Go to checkout";', 'checkout'],
    ['const k = "Upgrade to Pro for more";', 'upgrade'],
    ['const k = "Start your free trial";', 'purchase'],
    ['const k = "Team: USD 15/month";', 'price amount'],
    ['const k = "Sign in with GitHub";', 'sign-in'],
    ['const k = "Create your Crafthall account";', 'account or price'],
    ['const k = "Our price is fair";', 'account or price'],
    ['const k = "Anonymous telemetry helps us";', 'telemetry'],
    ['const u = "https://api.crafthall-engine.example/v1";', 'URL outside the documentation allow list'],
    ['const u = "http://crafthall.dev";', 'URL outside the documentation allow list'],
  ])('catches %s', (text, rule) => {
    expect(js(text)).toContain(rule);
  });

  it('docs: paid phrases and foreign URLs are findings; truthful "no account, no sign-in, no telemetry" is not', () => {
    expect(md('Free. No account, no sign-in, no telemetry. See https://crafthall.dev and https://code.claude.com/docs/en/costs.')).toEqual([]);
    expect(md('Buy a licence key at checkout: USD 15/month. https://tracker.example.com/x')).toEqual(
      expect.arrayContaining(['licence key', 'checkout', 'price amount', 'URL outside the documentation allow list']),
    );
  });

  it('package.json: a runtime dependency or an install script is a finding', () => {
    const pkg = (o: object) => scanFile({ path: 'package.json', text: JSON.stringify(o) }).map((f) => f.rule);
    expect(pkg({ name: 'x', scripts: { build: 'b', prepublishOnly: 'g' } })).toEqual([]);
    expect(pkg({ dependencies: { left: '1' } })).toEqual(['runtime dependency']);
    expect(pkg({ scripts: { postinstall: 'node x' } })).toEqual(['install script']);
  });
});
