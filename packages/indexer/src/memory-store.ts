/**
 * In-memory Store — for tests and for a throwaway local explorer.
 *
 * It exists so the ingestion logic in §8.1 (backfill, reorg rewind, idempotent
 * upserts) can be tested exhaustively without a database. The Postgres
 * implementation is held to the same suite, so a behavioural difference
 * between the two shows up as a failing test rather than as a production-only
 * surprise.
 */

import { statusSucceeded, ZERO_BYTES32, type Hex } from '@0gflow/core';
import type { AgentRow, FlowRow, RunRow, SealInput, StepRow, Store } from './store.js';

const key = (runId: string, stepIndex: number) => `${runId.toLowerCase()}:${stepIndex}`;

export class MemoryStore implements Store {
  private cursor = 0n;
  private readonly blocks = new Map<string, string>();
  private readonly steps = new Map<string, StepRow>();
  private readonly seals = new Map<string, SealInput>();
  private readonly flows = new Map<string, FlowRow>();

  async getCursor() {
    return this.cursor;
  }

  async setCursor(block: bigint) {
    this.cursor = block;
  }

  async getIndexedBlockHash(blockNumber: bigint) {
    return this.blocks.get(blockNumber.toString()) ?? null;
  }

  async recordBlock(blockNumber: bigint, blockHash: string) {
    this.blocks.set(blockNumber.toString(), blockHash);
  }

  async rollbackFrom(blockNumber: bigint) {
    for (const [k, step] of this.steps) {
      if (step.blockNumber >= blockNumber) this.steps.delete(k);
    }
    for (const [k, seal] of this.seals) {
      if (seal.blockNumber >= blockNumber) this.seals.delete(k);
    }
    for (const [k, flow] of this.flows) {
      if (flow.blockNumber >= blockNumber) this.flows.delete(k);
    }
    for (const [k] of this.blocks) {
      if (BigInt(k) >= blockNumber) this.blocks.delete(k);
    }
    if (this.cursor >= blockNumber) this.cursor = blockNumber > 0n ? blockNumber - 1n : 0n;
  }

  async upsertStep(step: StepRow) {
    this.steps.set(key(step.runId, step.stepIndex), step);
  }

  async upsertSeal(seal: SealInput) {
    this.seals.set(seal.runId.toLowerCase(), seal);
  }

  async upsertFlow(flow: FlowRow) {
    this.flows.set(flow.flowId.toLowerCase(), flow);
  }

  private stepsFor(runId: string): StepRow[] {
    return [...this.steps.values()]
      .filter((s) => s.runId.toLowerCase() === runId.toLowerCase())
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }

  private runFrom(runId: string): RunRow | null {
    const steps = this.stepsFor(runId);
    const seal = this.seals.get(runId.toLowerCase());
    if (steps.length === 0 && seal === undefined) return null;

    const blocks = steps.map((s) => s.blockNumber);
    if (seal !== undefined) blocks.push(seal.blockNumber);

    return {
      runId: (steps[0]?.runId ?? seal!.runId) as Hex,
      flowId: (steps[0]?.flowId ?? ZERO_BYTES32) as Hex,
      stepCount: steps.length,
      sealed: seal !== undefined,
      chainRoot: seal?.chainRoot ?? null,
      outcome: seal?.outcome ?? null,
      firstBlock: blocks.reduce((min, b) => (b < min ? b : min), blocks[0] ?? 0n),
      lastBlock: blocks.reduce((max, b) => (b > max ? b : max), blocks[0] ?? 0n),
    };
  }

  async getRun(runId: Hex) {
    return this.runFrom(runId);
  }

  async getSteps(runId: Hex) {
    return this.stepsFor(runId);
  }

  private allRunIds(): string[] {
    const ids = new Set<string>();
    for (const step of this.steps.values()) ids.add(step.runId.toLowerCase());
    for (const seal of this.seals.values()) ids.add(seal.runId.toLowerCase());
    return [...ids];
  }

  async listRuns(limit: number, offset: number) {
    return this.allRunIds()
      .map((id) => this.runFrom(id)!)
      .sort((a, b) => Number(b.lastBlock - a.lastBlock))
      .slice(offset, offset + limit);
  }

  async getFlow(flowId: Hex) {
    return this.flows.get(flowId.toLowerCase()) ?? null;
  }

  async listRunsForFlow(flowId: Hex, limit: number) {
    return (await this.listRuns(1000, 0))
      .filter((r) => r.flowId.toLowerCase() === flowId.toLowerCase())
      .slice(0, limit);
  }

  async getAgent(agentId: bigint): Promise<AgentRow | null> {
    const steps = [...this.steps.values()].filter((s) => s.agentId === agentId);
    if (steps.length === 0) return null;
    return {
      agentId,
      stepCount: steps.length,
      okCount: steps.filter((s) => statusSucceeded(s.status)).length,
      attestedCount: steps.filter((s) => s.attestationRef !== ZERO_BYTES32).length,
      runCount: new Set(steps.map((s) => s.runId.toLowerCase())).size,
    };
  }

  async listRunsForAgent(agentId: bigint, limit: number) {
    const runIds = new Set(
      [...this.steps.values()].filter((s) => s.agentId === agentId).map((s) => s.runId.toLowerCase()),
    );
    return (await this.listRuns(1000, 0)).filter((r) => runIds.has(r.runId.toLowerCase())).slice(0, limit);
  }

  async stats() {
    return {
      runs: this.allRunIds().length,
      steps: this.steps.size,
      flows: this.flows.size,
      agents: new Set([...this.steps.values()].map((s) => s.agentId.toString())).size,
      cursor: this.cursor,
    };
  }
}
