/**
 * Event decoding for the verifier — spec §9 step 1.
 *
 * Hand-rolled rather than taken from a library, because §9 requires the
 * verifier to be independently auditable: a verification tool with a large
 * transitive dependency tree is not something a third party can reasonably
 * check. Both events are entirely static types, so decoding is just reading
 * 32-byte words.
 *
 * Topic hashes are computed from the signatures at load time rather than
 * pasted in. A pasted topic that drifts from the deployed contract makes
 * eth_getLogs return nothing, and "no logs" looks identical to "no such run".
 */

import { keccak256, StepStatus, type Hex, type Receipt } from '@0gflow/core';

export interface RawLog {
  readonly address: string;
  readonly topics: string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
  readonly removed?: boolean;
}

/** A receipt as recovered from chain, with the provenance needed to anchor it. */
export interface AnchoredReceipt extends Receipt {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export interface Seal {
  readonly runId: Hex;
  readonly chainRoot: Hex;
  readonly stepCount: number;
  readonly outcome: number;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
}

const topicOf = (signature: string): Hex =>
  keccak256(new TextEncoder().encode(signature));

export const STEP_ANCHORED_SIGNATURE =
  'StepAnchored(bytes32,bytes32,uint32,uint256,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint8)';
export const RUN_SEALED_SIGNATURE = 'RunSealed(bytes32,bytes32,uint32,uint8)';

export const STEP_ANCHORED_TOPIC = topicOf(STEP_ANCHORED_SIGNATURE);
export const RUN_SEALED_TOPIC = topicOf(RUN_SEALED_SIGNATURE);

export class DecodeError extends Error {
  override readonly name = 'DecodeError';
}

/** Reads the nth 32-byte word of a hex data blob. */
function word(data: string, index: number, field: string): string {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const start = index * 64;
  if (body.length < start + 64) {
    // Reading past the end would fabricate zeros, producing a receipt that
    // then fails verification for a reason pointing nowhere near the cause.
    throw new DecodeError(
      `log data is truncated: need ${(index + 1) * 32} bytes for ${field} but have ${body.length / 2}`,
    );
  }
  return body.slice(start, start + 64);
}

const asBytes32 = (w: string): Hex => `0x${w.toLowerCase()}`;
const asUint = (w: string): bigint => BigInt(`0x${w}`);

function requireTopic(log: RawLog, expected: Hex, count: number, name: string): void {
  if (log.topics.length !== count) {
    throw new DecodeError(`${name}: expected ${count} topics, got ${log.topics.length}`);
  }
  if (log.topics[0]?.toLowerCase() !== expected) {
    throw new DecodeError(`${name}: topic0 is ${log.topics[0]}, expected ${expected}`);
  }
}

function assertStatus(value: bigint): StepStatus {
  if (value > 3n) throw new DecodeError(`unknown status ${value}`);
  return Number(value) as StepStatus;
}

export function decodeStepAnchored(log: RawLog): AnchoredReceipt {
  requireTopic(log, STEP_ANCHORED_TOPIC, 4, 'StepAnchored');

  const stepIndex = asUint(log.topics[3]!.slice(2));
  if (stepIndex > 0xffffffffn) throw new DecodeError(`stepIndex exceeds uint32: ${stepIndex}`);

  return {
    flowId: asBytes32(log.topics[1]!.slice(2)),
    runId: asBytes32(log.topics[2]!.slice(2)),
    stepIndex: Number(stepIndex),
    agentId: asUint(word(log.data, 0, 'agentId')),
    inputHash: asBytes32(word(log.data, 1, 'inputHash')),
    outputHash: asBytes32(word(log.data, 2, 'outputHash')),
    traceRoot: asBytes32(word(log.data, 3, 'traceRoot')),
    attestationRef: asBytes32(word(log.data, 4, 'attestationRef')),
    startedAt: asUint(word(log.data, 5, 'startedAt')),
    endedAt: asUint(word(log.data, 6, 'endedAt')),
    status: assertStatus(asUint(word(log.data, 7, 'status'))),
    txHash: log.transactionHash.toLowerCase() as Hex,
    blockNumber: BigInt(log.blockNumber),
    logIndex: Number(BigInt(log.logIndex)),
  };
}

export function decodeRunSealed(log: RawLog): Seal {
  requireTopic(log, RUN_SEALED_TOPIC, 2, 'RunSealed');

  return {
    runId: asBytes32(log.topics[1]!.slice(2)),
    chainRoot: asBytes32(word(log.data, 0, 'chainRoot')),
    stepCount: Number(asUint(word(log.data, 1, 'stepCount'))),
    outcome: Number(asUint(word(log.data, 2, 'outcome'))),
    txHash: log.transactionHash.toLowerCase() as Hex,
    blockNumber: BigInt(log.blockNumber),
  };
}
