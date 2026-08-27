/**
 * Signature recovery, checked against viem.
 *
 * viem is a dev dependency of the executor and cannot be used in core (§9
 * makes the verifier zero-dependency), but it is exactly the right thing to
 * *test* against: an independent implementation, widely used, with the same
 * semantics ethers uses — and ethers is what the 0G Compute SDK verifies with.
 *
 * A vector restated from this implementation would prove nothing.
 */

import { describe, expect, test } from 'vitest';
import {
  privateKeyToAccount,
  generatePrivateKey,
} from 'viem/accounts';
import { hashMessage, recoverMessageAddress as viemRecoverMessageAddress } from 'viem';
import {
  Secp256k1Error,
  addressesEqual,
  hashPersonalMessage,
  parseSignature,
  publicKeyToAddress,
  recoverAddress,
  recoverMessageAddress,
  toChecksumAddress,
} from '../src/secp256k1.js';
import { hexToBytes } from '../src/hash.js';

// A fixed key so failures are reproducible. Test-only, never funded.
const PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const account = privateKeyToAccount(PRIVATE_KEY);

describe('EIP-191 message hashing', () => {
  test('matches viem for ASCII, empty, unicode and long messages', async () => {
    for (const message of [
      'hello',
      '',
      'a'.repeat(1000),
      'héllo 世界 🌍',
      '{"text":"Summary: the audit found no critical findings."}',
    ]) {
      expect(hashPersonalMessage(message), `message: ${message.slice(0, 30)}`).toBe(
        hashMessage(message),
      );
    }
  });

  test('uses the byte length, not the character count', async () => {
    // "🌍" is one character and four UTF-8 bytes. Prefixing with 1 instead of
    // 4 yields a well-formed digest that recovers a plausible wrong address.
    const message = '🌍';
    expect(new TextEncoder().encode(message).length).toBe(4);
    expect(hashPersonalMessage(message)).toBe(hashMessage(message));
  });
});

describe('address recovery', () => {
  test('recovers the signer of a personal_sign message', async () => {
    const message = 'the enclave produced this output';
    const signature = await account.signMessage({ message });

    expect(addressesEqual(recoverMessageAddress(message, signature), account.address)).toBe(true);
  });

  test('agrees with viem across many random keys and messages', async () => {
    for (let i = 0; i < 25; i++) {
      const key = generatePrivateKey();
      const signer = privateKeyToAccount(key);
      const message = `message ${i} ${'x'.repeat(i * 7)}`;
      const signature = await signer.signMessage({ message });

      const mine = recoverMessageAddress(message, signature);
      const theirs = await viemRecoverMessageAddress({ message, signature });

      expect(addressesEqual(mine, theirs), `iteration ${i}`).toBe(true);
      expect(addressesEqual(mine, signer.address)).toBe(true);
    }
  }, 60_000);

  test('recovers over a raw digest as well as a message', async () => {
    const message = 'raw digest path';
    const signature = await account.signMessage({ message });
    expect(recoverAddress(hashMessage(message), signature)).toBe(
      recoverMessageAddress(message, signature).toLowerCase(),
    );
  });

  test('a different message recovers a different address', async () => {
    // The property the whole binding rests on: a signature over one output
    // must not verify against another.
    const signature = await account.signMessage({ message: 'output A' });
    expect(addressesEqual(recoverMessageAddress('output B', signature), account.address)).toBe(
      false,
    );
  });

  test('a one-bit change in the message breaks the recovery', async () => {
    const signature = await account.signMessage({ message: 'value: 95' });
    expect(addressesEqual(recoverMessageAddress('value: 96', signature), account.address)).toBe(
      false,
    );
  });

  test('returns a lowercase 0x address', async () => {
    const signature = await account.signMessage({ message: 'case' });
    expect(recoverMessageAddress('case', signature)).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe('signature parsing', () => {
  test('accepts both the 27/28 and 0/1 conventions', async () => {
    const message = 'both conventions';
    const signature = await account.signMessage({ message });
    const bytes = hexToBytes(signature);

    const v = bytes[64]!;
    expect([27, 28]).toContain(v);

    const raw = new Uint8Array(bytes);
    raw[64] = v - 27;
    expect(recoverAddress(hashMessage(message), raw)).toBe(
      recoverAddress(hashMessage(message), bytes),
    );
  });

  test('rejects a wrong-length signature', () => {
    expect(() => parseSignature(new Uint8Array(64))).toThrow('must be 65 bytes');
    expect(() => parseSignature(new Uint8Array(66))).toThrow('must be 65 bytes');
  });

  test('rejects an unsupported v byte rather than guessing', () => {
    // A chain-encoded EIP-155 v belongs to a transaction, not to
    // personal_sign. Guessing would recover a plausible wrong address.
    const bytes = new Uint8Array(65);
    bytes[31] = 1;
    bytes[63] = 1;
    bytes[64] = 37;
    expect(() => parseSignature(bytes)).toThrow('unsupported signature v byte');
  });

  test('rejects r or s outside the group order', () => {
    const bytes = new Uint8Array(65).fill(0xff);
    bytes[64] = 27;
    expect(() => parseSignature(bytes)).toThrow(Secp256k1Error);
  });

  test('rejects a zero r or s', () => {
    const bytes = new Uint8Array(65);
    bytes[64] = 27;
    expect(() => parseSignature(bytes)).toThrow('out of range');
  });

  test('rejects the malleable high-s form', async () => {
    // Every ECDSA signature has a second valid encoding with s = N - s.
    // Accepting both would let one signed output appear under two different
    // attestation digests.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const signature = await account.signMessage({ message: 'malleable' });
    const bytes = hexToBytes(signature);

    const s = BigInt('0x' + Buffer.from(bytes.slice(32, 64)).toString('hex'));
    const flipped = new Uint8Array(bytes);
    flipped.set(hexToBytes((N - s).toString(16).padStart(64, '0')), 32);
    flipped[64] = bytes[64] === 27 ? 28 : 27;

    expect(() => parseSignature(flipped)).toThrow('high half');
  });
});

describe('public keys and addresses', () => {
  test('derives the account address from its public key', () => {
    const uncompressed = hexToBytes(account.publicKey);
    expect(addressesEqual(publicKeyToAddress(uncompressed), account.address)).toBe(true);
  });

  test('accepts a key with or without the 0x04 prefix', () => {
    const withPrefix = hexToBytes(account.publicKey);
    expect(withPrefix[0]).toBe(0x04);
    expect(publicKeyToAddress(withPrefix)).toBe(publicKeyToAddress(withPrefix.slice(1)));
  });

  test('rejects a wrong-length key', () => {
    expect(() => publicKeyToAddress(new Uint8Array(32))).toThrow('must be 64 bytes');
  });

  test('produces EIP-55 checksums matching viem', () => {
    expect(toChecksumAddress(account.address.toLowerCase())).toBe(account.address);
    // The address observed in a real 0G Compute report_data.
    expect(toChecksumAddress('0x83df4b8eba7c0b3b740019b8c9a77fff77d508cf')).toBe(
      '0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF',
    );
  });

  test('rejects a non-address', () => {
    expect(() => toChecksumAddress('0x1234')).toThrow('not an address');
  });
});

describe('addressesEqual', () => {
  test('ignores case and prefix', () => {
    expect(addressesEqual('0xABCD', 'abcd')).toBe(true);
    expect(addressesEqual('0xABCD', '0xabce')).toBe(false);
  });
});
