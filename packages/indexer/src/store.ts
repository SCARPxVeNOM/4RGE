/**
 * Indexer storage contract — spec §8.1.
 *
 * The interface exists so ingestion logic (backfill, reorg rewind, idempotent
 * upserts) can be tested without infrastructure, while the production path
 * runs on Postgres 16 as the spec requires.
 *
 * Every write here is idempotent and keyed so a reorg can undo it: rows carry
 * the block they came from, because an indexer that cannot forget serves
 * receipts that no longer exist on chain.
 */

import type { Hex, StepStatus } from '@0gflow/core';

export interface StepRow {
  readonly runId: Hex;
  readonly flowId: Hex;
  readonly stepIndex: number;
  readonly agentId: bigint;
  readonly inputHash: Hex;
  readonly outputHash: Hex;
  readonly traceRoot: Hex;
  readonly attestationRef: Hex;
  readonly startedAt: bigint;
  readonly endedAt: bigint;
  readonly status: StepStatus;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly logIndex: number;
}

export interface RunRow {
  readonly runId: Hex;
  readonly flowId: Hex;
  readonly stepCount: number;
  readonly sealed: boolean;
  readonly chainRoot: Hex | null;
  readonly outcome: number | null;
  readonly firstBlock: bigint;
  readonly lastBlock: bigint;
}

export interface AgentRow {
  readonly agentId: bigint;
  readonly stepCount: number;
  readonly okCount: number;
  readonly attestedCount: number;
  readonly runCount: number;
}

export interface FlowRow {
  readonly flowId: Hex;
  readonly name: string;
  readonly owner: Hex;
  readonly specRoot: Hex;
  readonly publishedAt: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export interface SealInput {
  readonly runId: Hex;
  readonly chainRoot: Hex;
  readonly stepCount: number;
  readonly outcome: number;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export interface Store {
  /** Highest block scanned. Ingestion resumes from here. */
  getCursor(): Promise<bigint>;
  setCursor(block: bigint): Promise<void>;

  /** Hash of a block we indexed, for detecting that it was replaced. */
  getIndexedBlockHash(blockNumber: bigint): Promise<string | null>;
  recordBlock(blockNumber: bigint, blockHash: string): Promise<void>;

  /** Removes everything at or above `blockNumber`. Called on reorg. */
  rollbackFrom(blockNumber: bigint): Promise<void>;

  upsertStep(step: StepRow): Promise<void>;
  upsertSeal(seal: SealInput): Promise<void>;
  upsertFlow(flow: FlowRow): Promise<void>;

  getRun(runId: Hex): Promise<RunRow | null>;
  getSteps(runId: Hex): Promise<StepRow[]>;
  listRuns(limit: number, offset: number): Promise<RunRow[]>;
  getFlow(flowId: Hex): Promise<FlowRow | null>;
  listRunsForFlow(flowId: Hex, limit: number): Promise<RunRow[]>;
  getAgent(agentId: bigint): Promise<AgentRow | null>;
  listRunsForAgent(agentId: bigint, limit: number): Promise<RunRow[]>;
  stats(): Promise<{ runs: number; steps: number; flows: number; agents: number; cursor: bigint }>;

  close?(): Promise<void>;
}
