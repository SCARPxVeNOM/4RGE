/**
 * Reading an agent's bond from `AgentReputationV1`.
 *
 * Hand-encoded like `signers.ts` and `agents.ts`: one static argument in, one
 * uint256 out, and no dependency on an artifact file that could drift from the
 * deployed contract.
 *
 * A read failure returns null, not zero. Those are different answers — zero
 * means "this agent has posted nothing", null means "I could not find out" —
 * and `evaluateReputation` refuses to treat the second as meeting a bar.
 * Collapsing them would let an RPC outage quietly hire an unbonded agent into
 * a flow that asked for a bond.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import type { Hex } from '@0gflow/core';
import type { StakeSource } from './execute.js';

/** keccak256('stakeOf(uint256)')[0:4] — `cast sig "stakeOf(uint256)"`. */
const STAKE_OF = '0x24a66539';

export interface ViemStakeSourceOptions {
  readonly rpcUrl: string;
  /** AgentReputationV1. */
  readonly reputation: Hex;
}

export class ViemStakeSource implements StakeSource {
  private readonly client: PublicClient;
  /**
   * One read per agent per run. A bond does not change mid-run in a way this
   * run should react to: an agent that unbonds halfway through was hired on
   * the terms that held when it was hired.
   */
  private readonly cache = new Map<string, bigint | null>();

  constructor(private readonly options: ViemStakeSourceOptions) {
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
  }

  async stakeOf(agentId: bigint): Promise<bigint | null> {
    const key = agentId.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = await this.read(agentId);
    this.cache.set(key, resolved);
    return resolved;
  }

  private async read(agentId: bigint): Promise<bigint | null> {
    if (agentId < 0n || agentId >= 1n << 256n) return null;
    try {
      const result = await this.client.call({
        to: this.options.reputation as `0x${string}`,
        data: `${STAKE_OF}${agentId.toString(16).padStart(64, '0')}` as `0x${string}`,
      });
      if (result.data === undefined || result.data.length < 66) return null;
      return BigInt(result.data);
    } catch {
      return null;
    }
  }
}
