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

/**
 * A marketplace listing, as published in `AgentAdapterRegistryV2`.
 *
 * Separate from `AgentRow`, which is derived statistics over anchored steps.
 * These are two genuinely different things and conflating them would hide the
 * gap that matters: a freshly published agent has a listing and no statistics
 * at all, and until now such an agent was invisible — it appeared in the
 * explorer only after it had already been hired.
 */
export interface AgentListingRow {
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
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

/**
 * What a prober observed when it last called a listed agent.
 *
 * UNLIKE EVERYTHING ELSE IN THIS STORE, THIS IS NOT VERIFIABLE.
 *
 * Receipts, seals and listings are on chain: anyone can recompute them and get
 * the same answer. This is one indexer's observation from one network vantage
 * at one moment, and a reader has no way to check it. It exists so a human
 * browsing the directory can tell a live agent from an abandoned one — not so
 * anything can be decided on it.
 *
 * The executor deliberately does not consume this. When a flow wants to know
 * whether an agent is up, it probes for itself; that answer is at least
 * verifiable by doing, and a dead agent produces a Failed step regardless.
 */
export interface AgentHealthRow {
  readonly agentId: bigint;
  /** Unix ms when the probe ran. */
  readonly checkedAt: bigint;
  readonly ok: boolean;
  /** Round-trip time of the successful probe; null when it failed. */
  readonly latencyMs: number | null;
  /**
   * How many probes in a row have failed.
   *
   * Kept because one failure is noise — a restart, a cold start, a blip — and
   * calling an agent down on the strength of it would be wrong more often
   * than right.
   */
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface AgentListingFilter {
  readonly activeOnly?: boolean;
  readonly kind?: number;
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
  /**
   * Records a listing. Keyed on agentId, and only ever moving forward: the
   * registry refuses a version that does not increase, so an out-of-order log
   * would otherwise overwrite the current listing with a stale one.
   */
  upsertAgentListing(listing: AgentListingRow): Promise<void>;
  /** Marks a listing inactive without touching the rest of it. */
  deactivateAgentListing(agentId: bigint, blockNumber: bigint): Promise<void>;

  getRun(runId: Hex): Promise<RunRow | null>;
  getSteps(runId: Hex): Promise<StepRow[]>;
  listRuns(limit: number, offset: number): Promise<RunRow[]>;
  getFlow(flowId: Hex): Promise<FlowRow | null>;
  listRunsForFlow(flowId: Hex, limit: number): Promise<RunRow[]>;
  getAgent(agentId: bigint): Promise<AgentRow | null>;
  getAgentListing(agentId: bigint): Promise<AgentListingRow | null>;
  /** Records a probe result, carrying the failure streak forward. */
  recordAgentHealth(
    agentId: bigint,
    result: { ok: boolean; latencyMs: number | null; error: string | null; checkedAt: bigint },
  ): Promise<void>;
  getAgentHealth(agentId: bigint): Promise<AgentHealthRow | null>;
  listAgentListings(
    limit: number,
    offset: number,
    filter?: AgentListingFilter,
  ): Promise<AgentListingRow[]>;
  listRunsForAgent(agentId: bigint, limit: number): Promise<RunRow[]>;
  stats(): Promise<{ runs: number; steps: number; flows: number; agents: number; cursor: bigint }>;

  close?(): Promise<void>;
}
