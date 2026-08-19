import { describe, expect, test } from 'vitest';
import { encodeReceipt, hashReceipt, type Receipt, StepStatus } from '../src/receipt.js';

/**
 * The expected bytes below come from:
 *   cast abi-encode "f((bytes32,bytes32,uint32,uint256,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint8))" ...
 * If this file and Solidity ever disagree, every chain root diverges.
 *
 * agentId is a uint256, not an address: both agent registries live on Galileo
 * identify agents by ERC-721 token id, not by account address —
 * ERC-8004 (0x7177a686…) and 0G's own ERC-7857 Agentic ID (0x2700F6A3…).
 * See docs/agent-identity.md.
 */

const RECEIPT: Receipt = {
  flowId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  runId: '0x2222222222222222222222222222222222222222222222222222222222222222',
  stepIndex: 7,
  agentId: 1n,
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
  '0000000000000000000000000000000000000000000000000000000000000001' +
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

  test('encodes agentId as a full uint256 word', () => {
    const word = encodeReceipt(RECEIPT).slice(2).slice(3 * 64, 4 * 64);
    expect(word).toBe('0000000000000000000000000000000000000000000000000000000000000001');
  });

  test('accepts a token id above the 160-bit address range', () => {
    // The reason this is not an address: nothing constrains an ERC-721 token
    // id to 20 bytes, and truncating one would collide two distinct agents.
    const big = { ...RECEIPT, agentId: (1n << 200n) + 7n };
    expect(() => encodeReceipt(big)).not.toThrow();
    expect(hashReceipt(big)).not.toBe(hashReceipt({ ...RECEIPT, agentId: 7n }));
  });

  test('hashReceipt is keccak256 of the encoding', () => {
    expect(hashReceipt(RECEIPT)).toBe(
      '0x8a5999198c4052570e862e464f36fe4af19f8f7211909027c89f72cee501a26d',
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
    ['agentId', { ...RECEIPT, agentId: 2n }],
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

  test('rejects an agentId outside uint256', () => {
    expect(() => encodeReceipt({ ...RECEIPT, agentId: -1n })).toThrow();
    expect(() => encodeReceipt({ ...RECEIPT, agentId: 2n ** 256n })).toThrow();
  });

  test('rejects malformed bytes32 values', () => {
    expect(() => encodeReceipt({ ...RECEIPT, flowId: '0x1234' })).toThrow();
    expect(() => encodeReceipt({ ...RECEIPT, traceRoot: '0xnothex' })).toThrow();
  });

  test('accepts bytes32 values case-insensitively', () => {
    const upper = { ...RECEIPT, inputHash: '0x' + '33'.repeat(32).toUpperCase() };
    expect(encodeReceipt(upper)).toBe(ENCODED);
  });
});
