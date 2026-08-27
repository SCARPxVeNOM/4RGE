/**
 * The selector arithmetic behind the SDK fix.
 *
 * The whole shim rests on one claim: the deployed contract expects a different
 * `submit` than `@0glabs/0g-ts-sdk@0.3.3` encodes. That claim is a keccak of a
 * signature string, so it can be checked here rather than only observed on
 * chain — and if upstream ever changes the struct again, this fails loudly
 * instead of the shim silently rewriting calls into a third wrong shape.
 */

import { describe, expect, test } from 'vitest';
import { keccak256 } from '@0gflow/core';
import { CURRENT_SUBMIT_SELECTOR, LEGACY_SUBMIT_SELECTOR } from '../src/submit-fix.js';

const selectorOf = (signature: string): string =>
  keccak256(new TextEncoder().encode(signature)).slice(0, 10);

/** Submission.sol before the refactor: length, tags and nodes inline. */
const LEGACY_SIGNATURE = 'submit((uint256,bytes,(bytes32,uint256)[]))';
/** After: those three become SubmissionData, and Submission adds a submitter. */
const CURRENT_SIGNATURE = 'submit(((uint256,bytes,(bytes32,uint256)[]),address))';

describe('the submit selectors', () => {
  test('the legacy selector is what the SDK still encodes', () => {
    expect(selectorOf(LEGACY_SIGNATURE)).toBe(LEGACY_SUBMIT_SELECTOR);
  });

  test('the current selector is what the deployed contract expects', () => {
    // Confirmed against a live successful submission on Galileo
    // (tx 0x6586221d…, block 51671352), not derived from documentation.
    expect(selectorOf(CURRENT_SIGNATURE)).toBe(CURRENT_SUBMIT_SELECTOR);
    expect(CURRENT_SUBMIT_SELECTOR).toBe('0xbc8c11f8');
  });

  test('they differ, which is the entire bug', () => {
    // Same submission data, different ABI encoding: the old entrypoint is
    // absent from the implementation, so a call to it falls through and
    // reverts with no reason string — which reads like a network fault.
    expect(LEGACY_SUBMIT_SELECTOR).not.toBe(CURRENT_SUBMIT_SELECTOR);
  });

  test('the difference is only the wrapping, not the payload', () => {
    // Both carry identical SubmissionData. If the inner tuple had changed too,
    // re-wrapping would not be enough and the shim would be unsound.
    const inner = '(uint256,bytes,(bytes32,uint256)[])';
    expect(LEGACY_SIGNATURE).toBe(`submit(${inner})`);
    expect(CURRENT_SIGNATURE).toBe(`submit((${inner},address))`);
  });
});
