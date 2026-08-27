/**
 * Agent output signatures — proving which agent produced a step's output.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A receipt carries `agentId`, and nothing checks that the executor was
 * entitled to write it. Anyone can anchor a step claiming any agent: on
 * Galileo today every reference agent claims `agentId` 1, which `ownerOf` says
 * belongs to a stranger. With a public directory and reputation derived from
 * receipts, that is not a curiosity — it is a way to poison someone else's
 * record, or to take credit for work they did.
 *
 * So the agent signs. The signature is over a digest that names the run, the
 * step, the agent and the output, and it verifies against the signing key that
 * agent published in `AgentAdapterRegistry`. A receipt whose `agentId` the
 * agent did not sign for proves nothing about that agent.
 *
 * WHY THE DIGEST HAS THESE FIELDS
 *
 * Each one closes a replay:
 *
 *   DOMAIN      a signature for something else in this system is not one of
 *               these — and vice versa
 *   chainId     a testnet signature cannot be replayed on mainnet
 *   receipts    nor against a different receipts contract on the same chain
 *   runId       nor lifted into another run
 *   stepIndex   nor moved to another step of the same run
 *   agentId     nor re-attributed to a different agent
 *   inputHash   nor presented as the answer to a different question
 *   outputHash  and it commits to the output itself, which is the point
 *
 * Drop `stepIndex` and an agent that legitimately signed step 3 has signed
 * every step. Drop `outputHash` and the signature says the agent was involved,
 * not what it produced. Drop `inputHash` and a correct answer to one question
 * can be re-presented as the answer to another.
 *
 * WHY EIP-191
 *
 * `hashPersonalMessage` over the 32 digest bytes produces exactly
 * `"\x19Ethereum Signed Message:\n32" ‖ digest`, which is byte-identical to
 * Solidity's `toEthSignedMessageHash`. So the SDK that signs, the executor
 * that records, the verifier that checks, and the escrow contract that pays
 * all agree without anyone writing a second scheme. Four implementations of
 * one digest is four chances for two of them to disagree — see §5.2, which
 * this is the same failure mode as.
 */

import { keccak256, type Hex } from './hash.js';
import {
  addressesEqual,
  hashPersonalMessage,
  recoverAddress,
  Secp256k1Error,
} from './secp256k1.js';

/** keccak256('0gflow-agent-output-v1'), fixed at the first deployment. */
export const AGENT_OUTPUT_DOMAIN: Hex =
  '0x' + keccak256(new TextEncoder().encode('0gflow-agent-output-v1')).slice(2);

export interface AgentOutputClaim {
  /** EVM chain the receipt is anchored on. */
  readonly chainId: number;
  /** The ExecutionReceipts contract the receipt is anchored in. */
  readonly receipts: Hex;
  readonly runId: Hex;
  readonly stepIndex: number;
  /** ERC-721 token id of the agent claiming the work. */
  readonly agentId: bigint;
  /** sha256 of the canonical input — the receipt's `inputHash`. */
  readonly inputHash: Hex;
  /** sha256 of the canonical output — the receipt's `outputHash`. */
  readonly outputHash: Hex;
}

export class AgentSignatureError extends Error {
  override readonly name = 'AgentSignatureError';
}

function word(value: bigint | number, field: string): string {
  const v = typeof value === 'number' ? BigInt(value) : value;
  if (v < 0n) throw new AgentSignatureError(`${field}: negative value ${v}`);
  if (v >= 1n << 256n) throw new AgentSignatureError(`${field}: exceeds uint256`);
  return v.toString(16).padStart(64, '0');
}

function fixed(value: Hex, bytes: number, field: string): string {
  const body = value.replace(/^0[xX]/, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(body)) throw new AgentSignatureError(`${field}: not hex: ${value}`);
  if (body.length !== bytes * 2) {
    throw new AgentSignatureError(`${field}: expected ${bytes} bytes, got ${body.length / 2}`);
  }
  // Left-pad into a 32-byte word, which is how Solidity's abi.encode lays out
  // an address as well as a bytes32.
  return body.padStart(64, '0');
}

/**
 * The digest an agent signs, matching Solidity's
 * `keccak256(abi.encode(DOMAIN, chainid, receipts, runId, stepIndex, agentId,
 * inputHash, outputHash))`.
 *
 * Every member is static, so `abi.encode` is just the eight words
 * concatenated — no offset prefix, no length words.
 *
 * `abi.encode` rather than a formatted string because `FlowEscrowV2` has to
 * recompute this digest on chain to release payment. Solidity does
 * `keccak256(abi.encode(...))` natively; formatting integers into a delimited
 * string costs gas and invites an off-by-one in the padding that no test would
 * catch until a payment silently stopped working.
 */
export function agentOutputDigest(claim: AgentOutputClaim): Hex {
  const encoded =
    fixed(AGENT_OUTPUT_DOMAIN, 32, 'domain') +
    word(claim.chainId, 'chainId') +
    fixed(claim.receipts, 20, 'receipts') +
    fixed(claim.runId, 32, 'runId') +
    word(claim.stepIndex, 'stepIndex') +
    word(claim.agentId, 'agentId') +
    fixed(claim.inputHash, 32, 'inputHash') +
    fixed(claim.outputHash, 32, 'outputHash');

  return keccak256(`0x${encoded}`);
}

/** The EIP-191 message hash actually signed. */
export function agentOutputMessageHash(claim: AgentOutputClaim): Hex {
  const digest = agentOutputDigest(claim);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(digest.slice(2 + i * 2, 4 + i * 2), 16);
  return hashPersonalMessage(bytes);
}

/**
 * The address that signed this claim, or null when the signature is unusable.
 *
 * Returns null rather than throwing: a malformed signature is a finding the
 * caller must turn into a status, not an exception that aborts a run.
 */
export function recoverAgentSigner(claim: AgentOutputClaim, signature: Hex): Hex | null {
  try {
    return recoverAddress(agentOutputMessageHash(claim), signature);
  } catch (error) {
    if (error instanceof Secp256k1Error || error instanceof AgentSignatureError) return null;
    throw error;
  }
}

/**
 * Whether `signature` is by the key the agent published for itself.
 *
 * `expectedSigner` comes from `AgentAdapterRegistry.signerOf(agentId)` — the
 * agent's own declaration, on chain, under the identity's ownership. A null
 * expected signer means the agent published no key, which cannot verify to
 * true: an unverifiable claim is not a proven one.
 */
export function verifyAgentSignature(
  claim: AgentOutputClaim,
  signature: Hex,
  expectedSigner: Hex | null,
): boolean {
  if (expectedSigner === null) return false;
  const recovered = recoverAgentSigner(claim, signature);
  return recovered !== null && addressesEqual(recovered, expectedSigner);
}
