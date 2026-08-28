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

// ---------------------------------------------------------------------------
// The marketplace registry — AgentAdapterRegistryV2
// ---------------------------------------------------------------------------

export const ADAPTER_REGISTERED_SIGNATURE =
  'AdapterRegistered(uint256,address,uint8,string,bytes32,uint32,bool,address,address,uint256,string)';
export const ADAPTER_DEACTIVATED_SIGNATURE = 'AdapterDeactivated(uint256,uint32)';

export const ADAPTER_REGISTERED_TOPIC = topicOf(ADAPTER_REGISTERED_SIGNATURE);
export const ADAPTER_DEACTIVATED_TOPIC = topicOf(ADAPTER_DEACTIVATED_SIGNATURE);

export interface AdapterListing {
  readonly agentId: bigint;
  readonly owner: Hex;
  readonly kind: number;
  readonly endpoint: string;
  readonly schemaRoot: Hex;
  readonly version: number;
  readonly active: boolean;
  readonly payTo: Hex;
  readonly signer: Hex;
  readonly pricePerCall: bigint;
  readonly metadataURI: string;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

const asAddress = (w: string): Hex => `0x${w.slice(24).toLowerCase()}`;

/**
 * Reads a dynamic `string` whose head word sits at `index`.
 *
 * Unlike the receipt events, this one is not all static types: the head word
 * holds a byte offset from the start of the data section, and the tail there
 * holds a length followed by the UTF-8 bytes. Offsets are validated against
 * the actual data length rather than trusted — a truncated log would otherwise
 * decode into a plausible-looking short string, and a directory entry with a
 * silently truncated endpoint is worse than one that fails to decode.
 */
function dynamicString(data: string, index: number, field: string): string {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const offset = Number(asUint(word(data, index, `${field} offset`)));
  if (offset % 32 !== 0 || offset * 2 + 64 > body.length) {
    throw new DecodeError(`${field}: offset ${offset} is outside the log data`);
  }

  const lengthHex = body.slice(offset * 2, offset * 2 + 64);
  const length = Number(BigInt(`0x${lengthHex}`));
  const start = offset * 2 + 64;
  if (start + length * 2 > body.length) {
    throw new DecodeError(
      `${field}: claims ${length} bytes but only ${(body.length - start) / 2} remain`,
    );
  }

  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(body.slice(start + i * 2, start + i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export function decodeAdapterRegistered(log: RawLog): AdapterListing {
  requireTopic(log, ADAPTER_REGISTERED_TOPIC, 3, 'AdapterRegistered');

  const kind = asUint(word(log.data, 0, 'kind'));
  const version = asUint(word(log.data, 3, 'version'));
  if (kind > 0xffn) throw new DecodeError(`kind exceeds uint8: ${kind}`);
  if (version > 0xffffffffn) throw new DecodeError(`version exceeds uint32: ${version}`);

  return {
    agentId: asUint(log.topics[1]!.slice(2)),
    owner: asAddress(log.topics[2]!.slice(2)),
    kind: Number(kind),
    // Head words, in declaration order of the non-indexed parameters:
    //   0 kind · 1 endpoint(offset) · 2 schemaRoot · 3 version · 4 active
    //   5 payTo · 6 signer · 7 pricePerCall · 8 metadataURI(offset)
    // A dynamic parameter still occupies exactly one head word, so the two
    // strings do not shift the words after them.
    endpoint: dynamicString(log.data, 1, 'endpoint'),
    schemaRoot: asBytes32(word(log.data, 2, 'schemaRoot')),
    version: Number(version),
    active: asUint(word(log.data, 4, 'active')) !== 0n,
    payTo: asAddress(word(log.data, 5, 'payTo')),
    signer: asAddress(word(log.data, 6, 'signer')),
    pricePerCall: asUint(word(log.data, 7, 'pricePerCall')),
    metadataURI: dynamicString(log.data, 8, 'metadataURI'),
    txHash: log.transactionHash.toLowerCase() as Hex,
    blockNumber: BigInt(log.blockNumber),
    logIndex: Number(BigInt(log.logIndex)),
  };
}

export interface AdapterDeactivation {
  readonly agentId: bigint;
  readonly version: number;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
}

export function decodeAdapterDeactivated(log: RawLog): AdapterDeactivation {
  requireTopic(log, ADAPTER_DEACTIVATED_TOPIC, 2, 'AdapterDeactivated');
  return {
    agentId: asUint(log.topics[1]!.slice(2)),
    version: Number(asUint(word(log.data, 0, 'version'))),
    txHash: log.transactionHash.toLowerCase() as Hex,
    blockNumber: BigInt(log.blockNumber),
  };
}

// ---------------------------------------------------------------------------
// The agent bond — AgentReputationV1
// ---------------------------------------------------------------------------

export const STAKED_SIGNATURE = 'Staked(uint256,address,uint256,uint256)';
export const SLASHED_SIGNATURE = 'Slashed(uint256,address,uint256,uint256,bytes32,uint32)';
export const UNSTAKE_REQUESTED_SIGNATURE = 'UnstakeRequested(uint256,uint64)';
export const WITHDRAWN_SIGNATURE = 'Withdrawn(uint256,address,uint256)';

export const STAKED_TOPIC = topicOf(STAKED_SIGNATURE);
export const SLASHED_TOPIC = topicOf(SLASHED_SIGNATURE);
export const UNSTAKE_REQUESTED_TOPIC = topicOf(UNSTAKE_REQUESTED_SIGNATURE);
export const WITHDRAWN_TOPIC = topicOf(WITHDRAWN_SIGNATURE);

/**
 * What a bond event says about an agent's stake, as an absolute state rather
 * than a delta.
 *
 * `Staked` carries the running total, not just the increment, so every event
 * here sets the bond outright. That makes replaying a log idempotent: an
 * indexer that sees the same event twice — a retry, an overlapping scan —
 * lands on the same number instead of double-counting.
 */
export interface BondChange {
  readonly agentId: bigint;
  /** The bond after this event. */
  readonly amount: bigint;
  /** Unix seconds a withdrawal unlocks; 0 when none is pending. */
  readonly unlockAt: bigint;
  readonly slashed: boolean;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

function bondBase(log: RawLog): Pick<BondChange, 'agentId' | 'txHash' | 'blockNumber' | 'logIndex'> {
  return {
    agentId: asUint(log.topics[1]!.slice(2)),
    txHash: log.transactionHash.toLowerCase() as Hex,
    blockNumber: BigInt(log.blockNumber),
    logIndex: Number(BigInt(log.logIndex)),
  };
}

export function decodeStaked(log: RawLog): BondChange {
  requireTopic(log, STAKED_TOPIC, 3, 'Staked');
  // data: amount, total. The total is what the bond now stands at; staking
  // also cancels any pending withdrawal, so unlockAt returns to zero.
  return { ...bondBase(log), amount: asUint(word(log.data, 1, 'total')), unlockAt: 0n, slashed: false };
}

export function decodeUnstakeRequested(log: RawLog, current: bigint): BondChange {
  requireTopic(log, UNSTAKE_REQUESTED_TOPIC, 2, 'UnstakeRequested');
  // The amount is unchanged; only the clock started. The caller supplies what
  // it already knows, because this event does not restate the bond.
  return { ...bondBase(log), amount: current, unlockAt: asUint(word(log.data, 0, 'unlockAt')), slashed: false };
}

export function decodeWithdrawn(log: RawLog): BondChange {
  requireTopic(log, WITHDRAWN_TOPIC, 3, 'Withdrawn');
  return { ...bondBase(log), amount: 0n, unlockAt: 0n, slashed: false };
}

export function decodeSlashed(log: RawLog): BondChange {
  requireTopic(log, SLASHED_TOPIC, 3, 'Slashed');
  // Permanent: a slashed identity cannot be rehabilitated by staking again,
  // so this flag never goes back.
  return { ...bondBase(log), amount: 0n, unlockAt: 0n, slashed: true };
}
