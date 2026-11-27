// Rounding may only weaken a verdict, never strengthen it (Lead decision on).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { printedVerdictCode, verdictCode } from '../src';

const strength = { 'not-enough-evidence': 0, 'likely-saving': 1, 'measured-saving': 2 } as const;

describe('printedVerdictCode', () => {
  it('an upper bound of 0.9996 prints as 1.000 and is not enough evidence', () => {
    expect(verdictCode(0.88, [0.7, 0.9996])).toBe('likely-saving');
    expect(printedVerdictCode(0.88, [0.7, 0.9996])).toBe('not-enough-evidence');
  });

  it('an upper bound of 0.8504 prints as 0.850 but stays likely, not measured', () => {
    expect(verdictCode(0.8, [0.7, 0.8504])).toBe('likely-saving');
    expect(printedVerdictCode(0.8, [0.7, 0.8504])).toBe('likely-saving');
  });

  it('property: the printed verdict is never stronger than the unrounded one', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.3, max: 1.3, noNaN: true }), fc.double({ min: 0, max: 0.4, noNaN: true }), fc.double({ min: 0, max: 0.4, noNaN: true }), (r, a, b) => {
        const ci: [number, number] = [r - a, r + b];
        expect(strength[printedVerdictCode(r, ci)]).toBeLessThanOrEqual(strength[verdictCode(r, ci)]);
      }),
      { numRuns: 2000 },
    );
  });
});
