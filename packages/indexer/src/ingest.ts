/**
 * Event ingestion — spec §8.1.
 *
 * "Backfills from the deployment block. Handles reorgs by tracking finality
 * depth and re-processing affected ranges."
 *
 * The reorg case is the one that matters. Blocks below the finality depth are
 * treated as settled and never re-checked, because re-verifying the whole
 * chain on every pass would make the indexer O(chain). Above it, each block we
 * previously indexed is compared against the chain's current hash for that
 * height; the first mismatch means everything from there on describes a chain
 * that no longer exists, so those rows are dropped and the range is rescanned.
 *
 * An indexer that cannot forget is worse than one that lags: it serves
 * receipts nobody can find on chain, and §1.3 exists to stop exactly that.
 */

import {
  ADAPTER_DEACTIVATED_TOPIC,
  ADAPTER_REGISTERED_TOPIC,
  decodeAdapterDeactivated,
  decodeAdapterRegistered,
  decodeRunSealed,
  decodeSlashed,
  decodeStaked,
  decodeStepAnchored,
  decodeUnstakeRequested,
  decodeWithdrawn,
  SLASHED_TOPIC,
  STAKED_TOPIC,
  UNSTAKE_REQUESTED_TOPIC,
  WITHDRAWN_TOPIC,
  RUN_SEALED_TOPIC,
  STEP_ANCHORED_TOPIC,
} from '@0gflow/verify/decode';
import type { RawLog } from '@0gflow/verify/decode';
import type { Hex } from '@0gflow/core';
import type { Store } from './store.js';

export interface RawLogWithBlock extends RawLog {
  readonly blockHash: string;
}

export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(fromBlock: bigint, toBlock: bigint, address: string): Promise<RawLogWithBlock[]>;
  getBlockHash(blockNumber: bigint): Promise<string>;
}

export interface IngestArgs {
  readonly store: Store;
  readonly chain: ChainReader;
  readonly contract: string;
  /**
   * `AgentAdapterRegistryV2`, so the directory is indexed too.
   *
   * Optional: an indexer pointed at a network without the marketplace
   * contracts still works, and simply has no listings. Without it a published
   * agent stays invisible until it has been hired at least once, which is the
   * wrong way round — discovery has to come first.
   */
  readonly adapterRegistry?: string;
  /**
   * `AgentReputationV1`, so bonds are indexed too.
   *
   * Optional, like the adapter registry: an indexer pointed at a network
   * without it works and simply shows no bonds.
   */
  readonly agentReputation?: string;
  readonly from: bigint;
  readonly to: bigint;
  /** Blocks below head-finalityDepth are treated as settled. */
  readonly finalityDepth: number;
}

export interface IngestResult {
  readonly scannedFrom: bigint;
  readonly scannedTo: bigint;
  readonly steps: number;
  readonly seals: number;
  readonly listings: number;
  readonly bonds: number;
  /** Set when a reorg was detected and rows were dropped from this height. */
  readonly reorgedFrom: bigint | null;
}

/**
 * Walks back through the unfinalised tail looking for the first block whose
 * indexed hash disagrees with the chain. Returns null when nothing we indexed
 * has been replaced.
 */
async function findReorg(
  store: Store,
  chain: ChainReader,
  from: bigint,
  to: bigint,
  finalityDepth: number,
): Promise<bigint | null> {
  const head = await chain.getBlockNumber();
  const finalised = head - BigInt(finalityDepth);
  // Only the unfinalised tail can change. Never re-check below this.
  const lowest = from > finalised ? from : finalised;

  let earliest: bigint | null = null;
  for (let block = lowest; block <= to; block++) {
    const indexed = await store.getIndexedBlockHash(block);
    if (indexed === null) continue;
    const actual = await chain.getBlockHash(block);
    if (actual !== indexed) {
      earliest = block;
      break;
    }
  }
  return earliest;
}

export async function ingestRange(args: IngestArgs): Promise<IngestResult> {
  const { store, chain, contract, adapterRegistry, agentReputation, to, finalityDepth } = args;
  let { from } = args;

  const reorgedFrom = await findReorg(store, chain, from, to, finalityDepth);
  if (reorgedFrom !== null) {
    // Everything from here describes a chain that no longer exists.
    await store.rollbackFrom(reorgedFrom);
    if (reorgedFrom < from) from = reorgedFrom;
  }

  // Both contracts over the same block range, so one reorg check and one
  // cursor cover them. Fetched separately because eth_getLogs takes a single
  // address here; merged and re-sorted below so ordering stays global.
  const logs = [
    ...(await chain.getLogs(from, to, contract)),
    ...(adapterRegistry === undefined ? [] : await chain.getLogs(from, to, adapterRegistry)),
    ...(agentReputation === undefined ? [] : await chain.getLogs(from, to, agentReputation)),
  ];
  let steps = 0;
  let seals = 0;
  let listings = 0;
  let bonds = 0;

  // Ascending order so a seal never lands before the receipts it counts.
  const ordered = [...logs].sort((a, b) => {
    const byBlock = Number(BigInt(a.blockNumber) - BigInt(b.blockNumber));
    return byBlock !== 0 ? byBlock : Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });

  for (const log of ordered) {
    const topic = log.topics[0]?.toLowerCase();
    await store.recordBlock(BigInt(log.blockNumber), log.blockHash);

    if (topic === STEP_ANCHORED_TOPIC) {
      const receipt = decodeStepAnchored(log);
      await store.upsertStep({
        runId: receipt.runId,
        flowId: receipt.flowId,
        stepIndex: receipt.stepIndex,
        agentId: receipt.agentId,
        inputHash: receipt.inputHash,
        outputHash: receipt.outputHash,
        traceRoot: receipt.traceRoot,
        attestationRef: receipt.attestationRef,
        startedAt: receipt.startedAt,
        endedAt: receipt.endedAt,
        status: receipt.status,
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        blockHash: log.blockHash,
        logIndex: receipt.logIndex,
      });
      steps += 1;
    } else if (topic === RUN_SEALED_TOPIC) {
      const seal = decodeRunSealed(log);
      await store.upsertSeal({
        runId: seal.runId,
        chainRoot: seal.chainRoot,
        stepCount: seal.stepCount,
        outcome: seal.outcome,
        txHash: seal.txHash,
        blockNumber: seal.blockNumber,
        blockHash: log.blockHash,
      });
      seals += 1;
    } else if (topic === ADAPTER_REGISTERED_TOPIC) {
      const listing = decodeAdapterRegistered(log);
      await store.upsertAgentListing({
        agentId: listing.agentId,
        owner: listing.owner,
        kind: listing.kind,
        endpoint: listing.endpoint,
        schemaRoot: listing.schemaRoot,
        version: listing.version,
        active: listing.active,
        payTo: listing.payTo,
        signer: listing.signer,
        pricePerCall: listing.pricePerCall,
        metadataURI: listing.metadataURI,
        blockNumber: listing.blockNumber,
        blockHash: log.blockHash,
      });
      listings += 1;
    } else if (topic === ADAPTER_DEACTIVATED_TOPIC) {
      // Registering an inactive adapter emits both events, and they arrive in
      // that order, so this correctly lands after the upsert above.
      const gone = decodeAdapterDeactivated(log);
      await store.deactivateAgentListing(gone.agentId, gone.blockNumber);
      listings += 1;
    } else if (
      topic === STAKED_TOPIC ||
      topic === SLASHED_TOPIC ||
      topic === WITHDRAWN_TOPIC ||
      topic === UNSTAKE_REQUESTED_TOPIC
    ) {
      // UnstakeRequested is the one event that does not restate the bond — it
      // only starts the clock — so the current amount is read back and carried
      // through rather than reset to zero.
      let change;
      if (topic === STAKED_TOPIC) change = decodeStaked(log);
      else if (topic === SLASHED_TOPIC) change = decodeSlashed(log);
      else if (topic === WITHDRAWN_TOPIC) change = decodeWithdrawn(log);
      else {
        const agentId = BigInt(log.topics[1]!);
        const held = (await store.getAgentBond(agentId))?.amount ?? 0n;
        change = decodeUnstakeRequested(log, held);
      }

      await store.upsertAgentBond({
        agentId: change.agentId,
        amount: change.amount,
        unlockAt: change.unlockAt,
        slashed: change.slashed,
        blockNumber: change.blockNumber,
        blockHash: log.blockHash,
      });
      bonds += 1;
    }
  }

  await store.setCursor(to);

  return { scannedFrom: from, scannedTo: to, steps, seals, listings, bonds, reorgedFrom };
}

export interface FollowArgs extends Omit<IngestArgs, 'from' | 'to'> {
  /** Where to start when the store has no cursor yet. */
  readonly deploymentBlock: bigint;
  readonly batchSize?: bigint;
  readonly onProgress?: (result: IngestResult) => void;
}

/**
 * Backfills from the cursor (or the deployment block) up to the current head,
 * in batches. Returns when it reaches the head; callers poll to follow.
 */
export async function catchUp(args: FollowArgs): Promise<IngestResult[]> {
  const { store, chain, deploymentBlock, batchSize = 5_000n, onProgress } = args;
  const results: IngestResult[] = [];

  const cursor = await store.getCursor();
  // Never scan below the deployment block. A cursor beneath it is nonsense —
  // a stale row, a shared database, a misconfiguration — and honouring it
  // means scanning from near genesis over a range where the contract did not
  // exist. That is not a slow correct answer; it is minutes of wasted RPC.
  const resume = cursor > 0n ? cursor + 1n : deploymentBlock;
  let from = resume > deploymentBlock ? resume : deploymentBlock;
  const head = await chain.getBlockNumber();

  while (from <= head) {
    const to = from + batchSize - 1n > head ? head : from + batchSize - 1n;
    const result = await ingestRange({ ...args, from, to });
    results.push(result);
    onProgress?.(result);
    // A reorg may have rewound the cursor behind us; resume from the store,
    // still never dropping below the deployment block.
    const next = (await store.getCursor()) + 1n;
    from = next > deploymentBlock ? next : deploymentBlock;
  }

  return results;
}

export type { Hex };
