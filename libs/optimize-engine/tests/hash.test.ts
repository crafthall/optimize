import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentHash, sha256Hex } from '../src/index';

const nodeSha = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with node:crypto on any string, including non-ASCII and block-boundary lengths (differential)', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 300 }), (s) => sha256Hex(s) === nodeSha(s)), { numRuns: 500 });
    for (let n = 50; n <= 130; n++) expect(sha256Hex('x'.repeat(n))).toBe(nodeSha('x'.repeat(n)));
  });

  it('agrees with node:crypto on any byte array (differential)', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 400 }), (b) => sha256Hex(b) === nodeSha(b)), { numRuns: 300 });
  });
});

describe('contentHash', () => {
  it('prefixes the algorithm and changes with the salt', () => {
    expect(contentHash('p')).toBe(`sha256:${nodeSha('p')}`);
    expect(contentHash('p', 's1')).toMatch(/^sha256-salted:[0-9a-f]{64}$/);
    expect(contentHash('p', 's1')).not.toBe(contentHash('p', 's2'));
  });
});
