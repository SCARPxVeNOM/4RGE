import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { foldChainRoot, ChainRootError } from '../src/chain-root.js';
import { type Receipt, StepStatus, ZERO_BYTES32 } from '../src/receipt.js';

const base = {
  flowId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  runId: '0x2222222222222222222222222222222222222222222222222222222222222222',
  agentId: 1n,
  attestationRef: ZERO_BYTES32,
  status: StepStatus.Ok,
} as const;

const STEP_0: Receipt = {
  ...base,
  stepIndex: 0,
  inputHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
  outputHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
  traceRoot: '0x5555555555555555555555555555555555555555555555555555555555555555',
  startedAt: 1755600000n,
  endedAt: 1755600123n,
};

const STEP_1: Receipt = {
  ...base,
  stepIndex: 1,
  inputHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
  outputHash: '0x6666666666666666666666666666666666666666666666666666666666666666',
  traceRoot: '0x7777777777777777777777777777777777777777777777777777777777777777',
  startedAt: 1755600200n,
  endedAt: 1755600300n,
};

// Independently computed with `cast abi-encode` + `cast keccak`.
const ROOT_1 = '0x2fb759143ca82327cb57465ca87865ad96e8cf870893aa445bbc2d7045e8bb68';
const ROOT_2 = '0xad6cdc56809f36caaefcae9c0e5b4edf2ddbab727a8a1ff8c7967299077ab494';

describe('foldChainRoot', () => {
  test('a single receipt folds to keccak256(abi.encode(receipt))', () => {
    expect(foldChainRoot([STEP_0])).toBe(ROOT_1);
  });

  test('subsequent receipts fold as keccak256(prevRoot || receiptHash)', () => {
    expect(foldChainRoot([STEP_0, STEP_1])).toBe(ROOT_2);
  });
});

describe('determinism under parallel completion', () => {
  // §1.1: steps may complete in any order under a parallel branch. The root is
  // defined by stepIndex order, so the physical anchoring order must not
  // influence it.
  test('is independent of the order receipts are supplied in', () => {
    expect(foldChainRoot([STEP_1, STEP_0])).toBe(foldChainRoot([STEP_0, STEP_1]));
  });

  test('is invariant across every permutation of a four-step run', () => {
    const steps = [0, 1, 2, 3].map((i) => ({ ...STEP_0, stepIndex: i }));
    const expected = foldChainRoot(steps);
    fc.assert(
      fc.property(fc.shuffledSubarray(steps, { minLength: 4, maxLength: 4 }), (shuffled) => {
        expect(foldChainRoot(shuffled)).toBe(expected);
      }),
    );
  });
});

describe('completeness of the step set', () => {
  // Without these checks an executor could omit an inconvenient step and still
  // produce a root that verifies.
  test('rejects a gap in stepIndex', () => {
    const steps = [STEP_0, { ...STEP_1, stepIndex: 2 }];
    expect(() => foldChainRoot(steps)).toThrow(ChainRootError);
  });

  test('rejects a duplicated stepIndex', () => {
    expect(() => foldChainRoot([STEP_0, { ...STEP_1, stepIndex: 0 }])).toThrow(ChainRootError);
  });

  test('rejects a set that does not start at zero', () => {
    expect(() => foldChainRoot([{ ...STEP_0, stepIndex: 1 }])).toThrow(ChainRootError);
  });

  test('rejects an empty run', () => {
    expect(() => foldChainRoot([])).toThrow(ChainRootError);
  });
});

describe('tamper detection', () => {
  test('mutating any receipt moves the root', () => {
    const tampered = [{ ...STEP_0, outputHash: '0x' + '44'.repeat(31) + '45' }, STEP_1];
    expect(foldChainRoot(tampered)).not.toBe(ROOT_2);
  });

  test('swapping the contents of two steps moves the root', () => {
    // Order-independence must come from stepIndex, not from the fold being
    // commutative. A commutative fold would return the same root here.
    const swapped = [
      { ...STEP_1, stepIndex: 0 },
      { ...STEP_0, stepIndex: 1 },
    ];
    expect(foldChainRoot(swapped)).not.toBe(ROOT_2);
  });

  test('truncating a run moves the root', () => {
    expect(foldChainRoot([STEP_0])).not.toBe(foldChainRoot([STEP_0, STEP_1]));
  });
});
