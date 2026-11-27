// QA review of the import-usage ranking arithmetic (stats-review-1031.md §10). Hand-computed cases for D2
// (both directions), D6 and the "not measurable" cutoff, plus fast-check laws of the shares. Prices: platform.claude.com
// pricing page (accessed 2026-11-26): 5m write 1.25x, 1h write 2x, read 0.1x on most models, output 5x input on every
// listed model; `compare` measures `total_cost_usd`, so a share is of the total token cost, output included.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkD2, checkD6, MDE_AT_RUN_CAP, minimumDetectableEffect, minimumDetectableEffectT, planDegreesOfFreedom, TOKEN_WEIGHTS } from '../src/index';
import type { RequestFields, SessionFields, ToolResultFields } from '../src/transcripts';

const MIN = 60_000;
const req = (t: number, f: Partial<RequestFields>): RequestFields => ({ t, sidechain: false, input: 0, write5m: 0, write1h: 0, read: 0, output: 0, ...f });
const session = (requests: RequestFields[], toolResults: ToolResultFields[] = []): SessionFields => ({ requests, toolResults, ttlSplit: true });
const shareOf = (d: ReturnType<typeof checkD2>[number] | undefined): number => (d && d.effect.kind === 'estimate' ? d.effect.share : NaN);

describe('review – cost weights', () => {
  it('weights match the pricing page ratios and output is weighted 5x input', () => {
    expect(TOKEN_WEIGHTS).toEqual({ input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 });
  });
});

describe('review – D2 by hand', () => {
  it('1h → 5m counts the reads after a mid gap even when that request also wrote at 1h (failing before: write1h === 0 filter)', () => {
    // Typical 1h user: after a 20-minute gap the next request reads the whole 50k prefix and writes its new message at 1h.
    // Under 5m those 50k would be written again: Δ = 0.75·W₁ − 1.15·R′ = 0.75·52,500 − 1.15·50,000 = −18,125 → no saving.
    const s = session([req(0, { write1h: 50_000 }), req(20 * MIN, { read: 50_000, write1h: 2_000 }), req(21 * MIN, { read: 52_000, write1h: 500 })]);
    expect(checkD2([s])).toEqual([]);
  });

  it('1h → 5m share = (0.75·W₁ − 1.15·R′) ÷ total, total with output at 5x', () => {
    // W₁ = 101,000; R′ = 10,000; Δ = 75,750 − 11,500 = 64,250. Total = 2·101,000 + 0.1·10,000 + 5·1,500 = 210,500.
    const s = session([req(0, { write1h: 100_000, output: 1_000 }), req(10 * MIN, { read: 10_000, write1h: 1_000, output: 500 })]);
    const [d] = checkD2([s]);
    expect(d?.id).toBe('D2-ttl-5m');
    expect(shareOf(d)).toBeCloseTo(64_250 / 210_500, 12);
  });

  it('5m → 1h share = (1.9·R − 0.75·W₅) ÷ total, total with output at 5x', () => {
    // W₅ = 40,000 + 41,000 + 500 = 81,500; R = 41,000 (the rewrite after the 12-minute gap); Δ = 77,900 − 61,125 = 16,775.
    // Total = 1.25·81,500 + 0.1·41,000 + 10·3 + 5·(800 + 900 + 200) = 101,875 + 4,100 + 30 + 9,500 = 115,505.
    const s = session([
      req(0, { input: 10, write5m: 40_000, output: 800 }),
      req(12 * MIN, { input: 10, write5m: 41_000, output: 900 }),
      req(13 * MIN, { input: 10, write5m: 500, read: 41_000, output: 200 }),
    ]);
    const [d] = checkD2([s]);
    expect(d?.id).toBe('D2-ttl-1h');
    expect(shareOf(d)).toBeCloseTo(16_775 / 115_505, 12);
  });

  it('gap boundaries: exactly 5 min and over 60 min do not count, 5 min + 1 ms and exactly 60 min do', () => {
    const at = (gap: number): number => {
      const s = session([req(0, { write5m: 10_000 }), req(gap, { write5m: 10_000 })]);
      return checkD2([s]).length;
    };
    // Δ = 1.9·10,000 − 0.75·20,000 = 4,000 > 0 when the gap counts, −15,000 → none when it does not.
    expect([at(5 * MIN), at(5 * MIN + 1), at(60 * MIN), at(60 * MIN + 1)]).toEqual([0, 1, 1, 0]);
  });
});

describe('review – D6 by hand', () => {
  it('share = excess·(1.25 + 0.1·(later − 1)) ÷ total, total with output at 5x', () => {
    // 28,000-char Bash result at t = 1; three later requests. Excess = (28,000 − 8,000) ÷ 4 = 5,000 tokens;
    // cost = 5,000·(1.25 + 0.1·2) = 7,250. Each request: 10 + 1.25·1,000 + 0.1·20,000 + 5·200 = 4,260; four → 17,040.
    const r = (t: number): RequestFields => req(t, { input: 10, write5m: 1_000, read: 20_000, output: 200 });
    const s = session([r(0), r(2), r(3), r(4)], [{ t: 1, bash: true, chars: 28_000 }]);
    const [d] = checkD6([], [s]);
    expect(d?.effect).toEqual({ kind: 'estimate', share: 7_250 / 17_040 });
  });

  it('threshold: 20,000 chars is not large, 20,001 is', () => {
    const s = (chars: number): SessionFields => session([req(0, { input: 100 }), req(2, { input: 100 })], [{ t: 1, bash: true, chars }]);
    expect(checkD6([], [s(20_000)])).toEqual([]);
    expect(checkD6([], [s(20_001)])).toHaveLength(1);
  });
});

describe('review – the "not measurable" cutoff', () => {
  it('is the t-based MDE at the run cap (30 per arm, 3 tasks, df 54), as the plan block prints (failing before: normal 19.13%)', () => {
    // Hand: σ = √ln 1.09 = 0.293560; t₀.₉₇₅,₅₄ + t₀.₈₀,₅₄ = 2.00488 + 0.84823 = 2.85311; √(2/30) = 0.258199;
    // 1 − exp(−2.85311·0.293560·0.258199) = 1 − exp(−0.216258) = 0.19447.
    expect(MDE_AT_RUN_CAP).toBeCloseTo(0.19447, 4);
    expect(MDE_AT_RUN_CAP).toBe(minimumDetectableEffectT(0.3, 30, planDegreesOfFreedom(30, 3)));
    expect(MDE_AT_RUN_CAP).toBeGreaterThan(minimumDetectableEffect(0.3, 30));
  });
});

const requestArb = (t: number): fc.Arbitrary<RequestFields> =>
  fc.record({
    t: fc.constant(t),
    sidechain: fc.boolean(),
    input: fc.nat(5_000),
    write5m: fc.nat(60_000),
    write1h: fc.nat(60_000),
    read: fc.nat(200_000),
    output: fc.nat(8_000),
  });
// Gaps from 0 to 90 minutes reach all three D2 windows (≤ 5 min, mid, > 60 min); chars reach both sides of 20,000.
const sessionArb: fc.Arbitrary<SessionFields> = fc
  .array(fc.integer({ min: 0, max: 90 * MIN }), { minLength: 1, maxLength: 10 })
  .chain((gaps) => {
    const ts = gaps.reduce<number[]>((a, g) => [...a, (a.at(-1) ?? 0) + g], []);
    return fc.record({
      requests: fc.tuple(...ts.map(requestArb)),
      toolResults: fc.array(fc.record({ t: fc.integer({ min: 0, max: ts.at(-1)! }), bash: fc.boolean(), chars: fc.integer({ min: 0, max: 200_000 }) }), { maxLength: 4 }),
      ttlSplit: fc.constant(true),
    });
  });

describe('review – properties', () => {
  it('D2 and D6 shares are finite, in (0, 1], and never grow when a request gains output tokens', () => {
    fc.assert(
      fc.property(fc.array(sessionArb, { minLength: 1, maxLength: 3 }), fc.nat(50_000), (sessions, extra) => {
        const more = sessions.map((s) => ({ ...s, requests: s.requests.map((r, i) => (i === 0 ? { ...r, output: r.output + extra } : r)) }));
        for (const check of [(x: SessionFields[]) => checkD2(x), (x: SessionFields[]) => checkD6([], x)]) {
          const a = check(sessions)[0];
          const b = check(more)[0];
          for (const d of [a, b]) if (d) expect(shareOf(d) > 0 && shareOf(d) <= 1 && Number.isFinite(shareOf(d))).toBe(true);
          if (a && b && a.id === b.id) expect(shareOf(b)).toBeLessThanOrEqual(shareOf(a) + 1e-12);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('on a 1h session, more reads after a mid gap never raise the 1h → 5m share', () => {
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(100_000), fc.nat(20_000), fc.nat(100_000), (w0, extra, w1, read) => {
        const mk = (r: number): SessionFields => session([req(0, { write1h: w0 + 1 }), req(30 * MIN, { write1h: w1, read: r })]);
        const a = shareOf(checkD2([mk(read)])[0]);
        const b = shareOf(checkD2([mk(read + extra)])[0]);
        if (Number.isNaN(a)) expect(Number.isNaN(b)).toBe(true);
        else if (!Number.isNaN(b)) expect(b).toBeLessThanOrEqual(a + 1e-12);
      }),
      { numRuns: 300 },
    );
  });
});
