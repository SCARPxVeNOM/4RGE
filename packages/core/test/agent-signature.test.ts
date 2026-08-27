/**
 * The agent output signature.
 *
 * Two things are being pinned here, and they matter for different reasons.
 *
 * The digest is pinned as a literal vector because four implementations have
 * to agree on it — the SDK that signs, the executor that records, the verifier
 * that checks, and `FlowEscrowV2` that pays. That is the §5.2 failure mode
 * moved to a new field: a disagreement produces a run that anchors ok and then
 * cannot be verified or paid, with nothing in the output pointing at the
 * cause. If this vector changes, Solidity's `AGENT_OUTPUT_DOMAIN` and the
 * escrow's digest must change with it, in the same commit.
 *
 * The replay cases are pinned because each digest field exists to close one,
 * and a field nobody tests is a field someone later removes as redundant.
 */

import { describe, expect, test } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { hashMessage } from 'viem';
import {
  AGENT_OUTPUT_DOMAIN,
  AgentSignatureError,
  agentOutputDigest,
  agentOutputMessageHash,
  recoverAgentSigner,
  verifyAgentSignature,
  type AgentOutputClaim,
} from '../src/agent-signature.js';
import { keccak256, type Hex } from '../src/hash.js';

const AGENT = privateKeyToAccount(
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
);
const IMPOSTER = privateKeyToAccount(
  '0x0123456789012345678901234567890123456789012345678901234567890123',
);

/**
 * A deliberately fictional chainId. `packages/config/test/networks.test.ts`
 * fails the build on a literal 0G chain id anywhere outside packages/config,
 * so that value cannot appear here — and the digest does not care which chain
 * it names, only that it names one.
 */
const CLAIM: AgentOutputClaim = {
  chainId: 31337,
  receipts: '0x741a36faba40ee71223539a5a062fdedc8574e30',
  runId: `0x${'22'.repeat(32)}`,
  stepIndex: 1,
  agentId: 7n,
  inputHash: `0x${'33'.repeat(32)}`,
  outputHash: `0x${'44'.repeat(32)}`,
};

const sign = (claim: AgentOutputClaim = CLAIM) =>
  AGENT.signMessage({ message: { raw: agentOutputDigest(claim) } });

describe('the domain separator', () => {
  test('is keccak256 of the versioned label', () => {
    // Solidity must hold the identical constant.
    expect(AGENT_OUTPUT_DOMAIN).toBe(
      keccak256(new TextEncoder().encode('0gflow-agent-output-v1')),
    );
    expect(AGENT_OUTPUT_DOMAIN).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('the digest', () => {
  test('is stable — pinned vector for Solidity and the SDKs', () => {
    // Recompute in Solidity with:
    //   keccak256(abi.encode(DOMAIN, uint256(31337), address(0x741a36…),
    //     bytes32(0x2222…), uint256(1), uint256(7),
    //     bytes32(0x3333…), bytes32(0x4444…)))
    expect(agentOutputDigest(CLAIM)).toBe('0x0c5bf6dabc2d3db97229a669ecf3f9793f03240b790514aa9add8d1a18332a15');
  });

  test('is eight abi-encoded words, so Solidity can reproduce it', () => {
    // Every member of the claim is a static type; if any were dynamic,
    // abi.encode would add an offset word and the two would diverge.
    const digest = agentOutputDigest(CLAIM);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('the message hash is EIP-191 over the digest, matching viem', () => {
    // viem's hashMessage({raw}) is what Solidity's toEthSignedMessageHash does.
    expect(agentOutputMessageHash(CLAIM)).toBe(
      hashMessage({ raw: agentOutputDigest(CLAIM) }),
    );
  });
});

describe('every digest field closes a replay', () => {
  const variants: [string, AgentOutputClaim][] = [
    ['chainId', { ...CLAIM, chainId: 1 }],
    ['receipts', { ...CLAIM, receipts: `0x${'ab'.repeat(20)}` }],
    ['runId', { ...CLAIM, runId: `0x${'33'.repeat(32)}` }],
    ['stepIndex', { ...CLAIM, stepIndex: 2 }],
    ['agentId', { ...CLAIM, agentId: 8n }],
    ['inputHash', { ...CLAIM, inputHash: `0x${'66'.repeat(32)}` }],
    ['outputHash', { ...CLAIM, outputHash: `0x${'55'.repeat(32)}` }],
  ];

  test.each(variants)('changing %s changes the digest', (_field, variant) => {
    expect(agentOutputDigest(variant)).not.toBe(agentOutputDigest(CLAIM));
  });

  test('a signature does not verify against any altered claim', async () => {
    const signature = (await sign()) as Hex;
    expect(verifyAgentSignature(CLAIM, signature, AGENT.address)).toBe(true);

    for (const [field, variant] of variants) {
      expect(
        verifyAgentSignature(variant, signature, AGENT.address),
        `${field} replay was accepted`,
      ).toBe(false);
    }
  });

  test('a signature for step 1 cannot be lifted onto step 3', async () => {
    // The concrete attack: an agent legitimately signs one step, and the
    // executor reuses that signature to claim the agent produced the others.
    const signature = (await sign({ ...CLAIM, stepIndex: 1 })) as Hex;
    expect(verifyAgentSignature({ ...CLAIM, stepIndex: 3 }, signature, AGENT.address)).toBe(
      false,
    );
  });
});

describe('verification', () => {
  test('accepts the agent’s own signature', async () => {
    const signature = (await sign()) as Hex;
    expect(recoverAgentSigner(CLAIM, signature)).toBe(AGENT.address.toLowerCase());
    expect(verifyAgentSignature(CLAIM, signature, AGENT.address)).toBe(true);
  });

  test('rejects a signature by another key', async () => {
    const signature = (await IMPOSTER.signMessage({
      message: { raw: agentOutputDigest(CLAIM) },
    })) as Hex;
    expect(verifyAgentSignature(CLAIM, signature, AGENT.address)).toBe(false);
  });

  test('an agent that published no signing key cannot be proven', async () => {
    // signerOf() returns nothing for an agent that never declared a key. That
    // must not verify to true: unverifiable is not proven.
    const signature = (await sign()) as Hex;
    expect(verifyAgentSignature(CLAIM, signature, null)).toBe(false);
  });

  test('a malformed signature is a finding, not an exception', () => {
    // The caller has to turn this into a status; throwing would abort the run.
    for (const bad of ['0x', '0xdeadbeef', `0x${'11'.repeat(64)}`] as Hex[]) {
      expect(recoverAgentSigner(CLAIM, bad)).toBeNull();
      expect(verifyAgentSignature(CLAIM, bad, AGENT.address)).toBe(false);
    }
  });

  test('is case-insensitive about the expected address', async () => {
    const signature = (await sign()) as Hex;
    expect(verifyAgentSignature(CLAIM, signature, AGENT.address.toUpperCase() as Hex)).toBe(
      true,
    );
  });
});

describe('malformed claims are rejected rather than hashed', () => {
  test('a wrong-length runId or outputHash', () => {
    expect(() => agentOutputDigest({ ...CLAIM, runId: '0x1234' })).toThrow(AgentSignatureError);
    expect(() => agentOutputDigest({ ...CLAIM, outputHash: '0x1234' })).toThrow(
      /expected 32 bytes/,
    );
  });

  test('a wrong-length receipts address', () => {
    expect(() => agentOutputDigest({ ...CLAIM, receipts: `0x${'ab'.repeat(32)}` })).toThrow(
      /expected 20 bytes/,
    );
  });

  test('a non-hex field', () => {
    expect(() => agentOutputDigest({ ...CLAIM, runId: `0x${'zz'.repeat(32)}` })).toThrow(
      /not hex/,
    );
  });

  test('an agentId beyond uint256, or negative', () => {
    expect(() => agentOutputDigest({ ...CLAIM, agentId: 1n << 256n })).toThrow(/uint256/);
    expect(() => agentOutputDigest({ ...CLAIM, agentId: -1n })).toThrow(/negative/);
  });

  test('the full uint256 agentId range is accepted', () => {
    // Token ids are uint256; narrowing anywhere would collide distinct agents.
    expect(agentOutputDigest({ ...CLAIM, agentId: (1n << 256n) - 1n })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
