import { describe, expect, test } from 'vitest';
import { encodeReceipt, hashReceipt, type Receipt, StepStatus } from '../src/receipt.js';

/**
 * The expected bytes below come from:
 *   cast abi-encode "f((bytes32,bytes32,uint32,address,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint8))" ...
 * If this file and Solidity ever disagree, every chain root diverges.
 */

const RECEIPT: Receipt = {
  flowId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  runId: '0x2222222222222222222222222222222222222222222222222222222222222222',
  stepIndex: 7,
  agentId: '0x00000000000000000000000000000000000000aa',
  inputHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
  outputHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
  traceRoot: '0x5555555555555555555555555555555555555555555555555555555555555555',
  attestationRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
  startedAt: 1755600000n,
  endedAt: 1755600123n,
  status: StepStatus.Unattested,
};

const ENCODED =
  '0x1111111111111111111111111111111111111111111111111111111111111111' +
  '2222222222222222222222222222222222222222222222222222222222222222' +
  '0000000000000000000000000000000000000000000000000000000000000007' +
  '00000000000000000000000000000000000000000000000000000000000000aa' +
  '3333333333333333333333333333333333333333333333333333333333333333' +
  '4444444444444444444444444444444444444444444444444444444444444444' +
  '5555555555555555555555555555555555555555555555555555555555555555' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000068a45480' +
  '0000000000000000000000000000000000000000000000000000000068a454fb' +
  '0000000000000000000000000000000000000000000000000000000000000003';

describe('encodeReceipt', () => {
  test('matches Solidity abi.encode byte for byte', () => {
    expect(encodeReceipt(RECEIPT)).toBe(ENCODED);
  });

  test('produces 11 static words with no dynamic offset prefix', () => {
    // The struct is fully static, so abi.encode emits only the head. A leading
    // 0x20 offset word here would mean the encoder treated it as dynamic.
    expect((encodeReceipt(RECEIPT).length - 2) / 2).toBe(11 * 32);
  });

  test('left-pads the address into its low 20 bytes', () => {
    const word = encodeReceipt(RECEIPT).slice(2).slice(3 * 64, 4 * 64);
    expect(word).toBe('00000000000000000000000000000000000000000000000000000000000000aa');
  });

  test('hashReceipt is keccak256 of the encoding', () => {
    expect(hashReceipt(RECEIPT)).toBe(
      '0x71574db4cd51506383f8a17050b5e5e63df758c656363598e85f74e4ce831de0',
    );
  });
});

describe('field sensitivity', () => {
  // §10.1 tamper detection: mutating any field must move the receipt hash.
  // A field the encoder silently drops would be unprotected by the chain root.
  const mutations: Array<[string, Receipt]> = [
    ['flowId', { ...RECEIPT, flowId: '0x' + '11'.repeat(31) + '12' }],
    ['runId', { ...RECEIPT, runId: '0x' + '22'.repeat(31) + '23' }],
    ['stepIndex', { ...RECEIPT, stepIndex: 8 }],
    ['agentId', { ...RECEIPT, agentId: '0x00000000000000000000000000000000000000ab' }],
    ['inputHash', { ...RECEIPT, inputHash: '0x' + '33'.repeat(31) + '34' }],
    ['outputHash', { ...RECEIPT, outputHash: '0x' + '44'.repeat(31) + '45' }],
    ['traceRoot', { ...RECEIPT, traceRoot: '0x' + '55'.repeat(31) + '56' }],
    ['attestationRef', { ...RECEIPT, attestationRef: '0x' + '00'.repeat(31) + '01' }],
    ['startedAt', { ...RECEIPT, startedAt: 1755600001n }],
    ['endedAt', { ...RECEIPT, endedAt: 1755600124n }],
    ['status', { ...RECEIPT, status: StepStatus.Ok }],
  ];

  test.each(mutations)('changing %s changes the receipt hash', (_field, mutated) => {
    expect(hashReceipt(mutated)).not.toBe(hashReceipt(RECEIPT));
  });

  test('every field mutation yields a distinct hash', () => {
    const hashes = new Set(mutations.map(([, r]) => hashReceipt(r)));
    expect(hashes.size).toBe(mutations.length);
  });
});

describe('validation', () => {
  test('rejects out-of-range field widths', () => {
    expect(() => encodeReceipt({ ...RECEIPT, stepIndex: 2 ** 32 })).toThrow();
    expect(() => encodeReceipt({ ...RECEIPT, stepIndex: -1 })).toThrow();
    expect(() => encodeReceipt({ ...RECEIPT, startedAt: 2n ** 64n })).toThrow();
    expect(() => encodeReceipt({ ...RECEIPT, status: 9 as StepStatus })).toThrow();
  });

  test('rejects malformed bytes32 and address values', () => {
    expect(() => encodeReceipt({ ...RECEIPT, flowId: '0x1234' })).toThrow();
    expect(() => encodeReceipt({ ...RECEIPT, agentId: '0xnothex' })).toThrow();
  });

  test('accepts a checksummed address case-insensitively', () => {
    const upper = { ...RECEIPT, agentId: '0x00000000000000000000000000000000000000AA' };
    expect(encodeReceipt(upper)).toBe(ENCODED);
  });
});
