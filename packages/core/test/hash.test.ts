import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { keccak256, sha256, hashJson, bytesToHex, hexToBytes } from '../src/hash.js';

/**
 * Vectors in this file were produced by `cast keccak` / `cast abi-encode`,
 * i.e. by the same implementation the contracts compile against. They are the
 * cross-language anchor for §5.2: any port that reproduces these bytes agrees
 * with the executor.
 */

describe('hex conversion', () => {
  test('round-trips bytes through hex', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (b) => {
        expect(hexToBytes(bytesToHex(b))).toStrictEqual(b);
      }),
    );
  });

  test('emits lowercase 0x-prefixed hex', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe('0x000fff');
  });

  test('accepts hex with or without prefix', () => {
    expect(hexToBytes('0xdeadbeef')).toStrictEqual(hexToBytes('deadbeef'));
    expect(hexToBytes('0xDEADBEEF')).toStrictEqual(hexToBytes('0xdeadbeef'));
  });

  test('rejects odd-length and non-hex input', () => {
    expect(() => hexToBytes('0xabc')).toThrow();
    expect(() => hexToBytes('0xzz')).toThrow();
  });
});

describe('keccak256', () => {
  // Node ships sha3-256, which is NOT keccak256: they differ in the padding
  // byte (0x06 vs 0x01). Using the wrong one produces plausible-looking
  // digests that never match the chain.
  test('matches cast keccak on known inputs', () => {
    expect(keccak256(new TextEncoder().encode(''))).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(keccak256(new TextEncoder().encode('abc'))).toBe(
      '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
    expect(keccak256(new TextEncoder().encode('hello'))).toBe(
      '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
    );
    expect(keccak256(new TextEncoder().encode('0gflow/1'))).toBe(
      '0xf36d96c71227e9ed37add1b6db9cce86fa5ccf09a06825b161bcf048f3fc5d3b',
    );
  });

  test('differs from SHA3-256 for the empty input', () => {
    // Guards against a future "optimisation" swapping in node:crypto sha3-256.
    expect(keccak256(new Uint8Array())).not.toBe(
      '0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
    );
  });

  test('hashes across the sponge rate boundary', () => {
    // Rate is 136 bytes; lengths either side exercise the multi-block path and
    // the padding edge case where the last block is exactly full.
    const at = new Uint8Array(136).fill(0x61);
    const over = new Uint8Array(137).fill(0x61);
    expect(keccak256(at)).toHaveLength(66);
    expect(keccak256(over)).toHaveLength(66);
    expect(keccak256(at)).not.toBe(keccak256(over));
  });

  test('accepts hex string input equivalently to bytes', () => {
    expect(keccak256('0x616263')).toBe(keccak256(new TextEncoder().encode('abc')));
  });

  test('is deterministic and length-preserving', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
        const h = keccak256(b);
        expect(h).toMatch(/^0x[0-9a-f]{64}$/);
        expect(keccak256(b)).toBe(h);
      }),
    );
  });
});

describe('sha256', () => {
  test('matches published vectors', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe(
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256(new Uint8Array())).toBe(
      '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('hashJson', () => {
  // §4.1: inputHash and outputHash are sha256 over the canonical JSON form.
  test('hashes the canonical form, not the supplied form', () => {
    expect(hashJson({ b: 1, a: 2 })).toBe(hashJson({ a: 2, b: 1 }));
  });

  test('is sha256 of the canonical UTF-8 bytes', () => {
    const expected = sha256(new TextEncoder().encode('{"a":1}'));
    expect(hashJson({ a: 1 })).toBe(expected);
  });

  test('separates values that differ only in type', () => {
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: '1' }));
    expect(hashJson([])).not.toBe(hashJson({}));
  });
});
