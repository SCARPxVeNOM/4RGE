/**
 * Receipt encoding — spec §4.1.
 *
 * This must reproduce Solidity's `abi.encode(Receipt)` exactly. Every field of
 * the struct is a static type, so the encoding is simply the eleven members
 * padded to 32 bytes and concatenated: no dynamic offset prefix, no length
 * words. Any field the encoder silently drops or reorders is a field the chain
 * root does not protect.
 */

import { keccak256, hexToBytes, type Hex } from './hash.js';

export enum StepStatus {
  Ok = 0,
  Failed = 1,
  Skipped = 2,
  /**
   * §1.3: a step that required an attestation and did not get one. It is never
   * Ok. Nothing in the codebase may map this to success.
   */
  Unattested = 3,
}

export interface Receipt {
  /** keccak256 of the canonical workflow spec. */
  readonly flowId: Hex;
  readonly runId: Hex;
  readonly stepIndex: number;
  /**
   * Agent identity as an ERC-721 token id.
   *
   * NOT an address. Both agent registries live on 0G Galileo identify agents
   * by token id, not by account address: ERC-8004 (0x7177a686…, "ERC-8004
   * Trustless Agent"/AGENT) and 0G's own ERC-7857 Agentic ID (0x2700F6A3…,
   * "Agentic ID"/AID). Nothing constrains a token id to 20 bytes, so
   * narrowing this to an address would collide distinct agents. See
   * docs/agent-identity.md.
   */
  readonly agentId: bigint;
  /** sha256 of canonical JSON input. */
  readonly inputHash: Hex;
  /** sha256 of canonical JSON output. */
  readonly outputHash: Hex;
  /** 0G Storage Merkle root of the execution trace. */
  readonly traceRoot: Hex;
  /** TEE attestation digest; zero when absent. */
  readonly attestationRef: Hex;
  readonly startedAt: bigint;
  readonly endedAt: bigint;
  readonly status: StepStatus;
}

export const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;

function encodeFixedBytes(value: Hex, width: number, field: string): string {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(value);
  } catch (cause) {
    throw new Error(`${field}: ${(cause as Error).message}`);
  }
  if (bytes.length !== width) {
    throw new Error(`${field}: expected ${width} bytes, got ${bytes.length}`);
  }
  // Left-pad into a 32-byte word; for bytes32 this is a no-op, for an address
  // it places the 20 bytes in the low-order end as Solidity does.
  return value.replace(/^0[xX]/, '').toLowerCase().padStart(64, '0');
}

function encodeUint(value: bigint | number, bits: number, field: string): string {
  const v = typeof value === 'number' ? BigInt(value) : value;
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new Error(`${field}: not an integer: ${value}`);
  }
  if (v < 0n) throw new Error(`${field}: negative value: ${v}`);
  if (v >= 1n << BigInt(bits)) throw new Error(`${field}: exceeds uint${bits}: ${v}`);
  return v.toString(16).padStart(64, '0');
}

/** Solidity `abi.encode(receipt)`, as 0x-prefixed hex. */
export function encodeReceipt(r: Receipt): Hex {
  if (!(r.status in StepStatus)) throw new Error(`status: unknown value ${r.status}`);
  const words = [
    encodeFixedBytes(r.flowId, 32, 'flowId'),
    encodeFixedBytes(r.runId, 32, 'runId'),
    encodeUint(r.stepIndex, 32, 'stepIndex'),
    encodeUint(r.agentId, 256, 'agentId'),
    encodeFixedBytes(r.inputHash, 32, 'inputHash'),
    encodeFixedBytes(r.outputHash, 32, 'outputHash'),
    encodeFixedBytes(r.traceRoot, 32, 'traceRoot'),
    encodeFixedBytes(r.attestationRef, 32, 'attestationRef'),
    encodeUint(r.startedAt, 64, 'startedAt'),
    encodeUint(r.endedAt, 64, 'endedAt'),
    encodeUint(r.status, 8, 'status'),
  ];
  return `0x${words.join('')}`;
}

/** keccak256(abi.encode(receipt)) — the leaf folded into the chain root. */
export function hashReceipt(r: Receipt): Hex {
  return keccak256(encodeReceipt(r));
}
