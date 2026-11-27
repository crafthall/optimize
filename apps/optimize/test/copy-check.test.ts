// R1-07: the copy check over the three public texts – README, marketplace listing, npm description – plus the
// plugin manifest's description (R1-02), and proof that every rule catches a planted example.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pluginManifest } from '../src/plugin-manifest';
import { BANNED, BILLING_CAVEAT, BILLING_LABELS, copyFindings, W11_FOOTER, type CopyKind } from './copy-check';

const APP = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(APP, p), 'utf8');
const TEXTS: [string, CopyKind][] = [
  ['README.md', 'full'],
  ['listing/marketplace.md', 'full'],
  ['listing/npm-description.txt', 'short'],
];

describe('public texts pass the copy check', () => {
  it.each(TEXTS)('%s', (path, kind) => expect(copyFindings(read(path), kind)).toEqual([]));

  it('the npm description is one line', () => {
    expect(read('listing/npm-description.txt').trimEnd().split('\n')).toHaveLength(1);
  });

  it('the plugin manifest description (plugin.json) passes as a short text: footer, no banned claim', () => {
    expect(copyFindings(pluginManifest().description, 'short')).toEqual([]);
  });
});

describe('the copy check catches planted problems', () => {
  const readme = read('README.md');
  const npm = read('listing/npm-description.txt');

  const planted: [string, string][] = [
    ['"proves"', 'Optimize proves that your change works.'],
    ['"verified quality"', 'Cheaper runs with verified quality.'],
    ['"quality unchanged"', 'Tokens down, quality unchanged.'],
    ['"no quality loss"', 'A cheaper setup with no quality loss.'],
    ['"nothing leaves"', 'Nothing leaves your machine.'],
    ['"you saved"', 'Last month you saved 30k tokens.'],
    ['"up to" + percentage', 'Cut token use by up to 40%.'],
    ['"up to" + percentage', 'Save up to 12.5 percent.'],
  ];
  it.each(planted)('a planted %s in the README is found: %s', (rule, phrase) => {
    const text = readme.replace('## What it does', `${phrase}\n\n## What it does`);
    expect(copyFindings(text, 'full').map((f) => f.rule)).toEqual([`banned claim ${rule}`]);
    expect(copyFindings(npm.replace('Not affiliated', `${phrase} Not affiliated`), 'short').map((f) => f.rule)).toEqual([`banned claim ${rule}`]);
  });

  it('every banned rule has a planted example', () => {
    expect(new Set(planted.map(([r]) => r))).toEqual(new Set(BANNED.map(([r]) => r)));
  });

  it('honest wording stays allowed (not proven, nothing was spent, up to a cap)', () => {
    const ok = 'The verdict is "likely saving, not proven". Plan only: nothing was run and nothing was spent. Up to 60 runs per comparison.';
    expect(copyFindings(`${ok}\n${W11_FOOTER}`, 'short')).toEqual([]);
  });

  it('a missing W11 footer is found in each kind', () => {
    expect(copyFindings(readme.replace(W11_FOOTER, ''), 'full')).toEqual([{ rule: 'missing W11 footer', match: W11_FOOTER }]);
    expect(copyFindings(npm.replace(W11_FOOTER, 'Not affiliated with Anthropic.'), 'short')).toEqual([{ rule: 'missing W11 footer', match: W11_FOOTER }]);
  });

  it('a missing Data section is found in the README and the marketplace text', () => {
    expect(copyFindings(readme.replace(/^## Data$/m, '## Privacy'), 'full')).toEqual([{ rule: 'missing Data section', match: '## Data or **Data**' }]);
    const market = read('listing/marketplace.md');
    expect(copyFindings(market.replace(/^\*\*Data\*\*$/m, '**Privacy**'), 'full')).toEqual([{ rule: 'missing Data section', match: '## Data or **Data**' }]);
  });

  it('a missing billing qualifier (a label or the client-side-estimate caveat) is found', () => {
    for (const label of BILLING_LABELS) {
      const text = readme.split(label).join('X');
      expect(copyFindings(text, 'full'), label).toContainEqual({ rule: 'missing billing qualifier', match: label });
    }
    expect(copyFindings(readme.split(BILLING_CAVEAT).join('an estimate'), 'full')).toEqual([{ rule: 'missing billing qualifier', match: BILLING_CAVEAT }]);
  });

  it('the npm line needs only the footer and no banned claim (no Data section or billing qualifier)', () => {
    expect(copyFindings(npm, 'short')).toEqual([]);
    expect(copyFindings(npm, 'full').map((f) => f.rule)).toContain('missing Data section');
  });
});
